#import "GBLocalize.h"
#import "GBPush.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBDiagnostics.h"
#import <Security/Security.h>
#import <UserNotifications/UserNotifications.h>
#import <dlfcn.h>
#import <objc/runtime.h>

static NSString *GBAPNsToken;
static NSString *GBRegistrationError;
static BOOL GBAuthorizing;
static BOOL GBAuthorizationAttempted;
static BOOL GBPromptVisible;
static IMP GBOriginalRegistered;
static IMP GBOriginalFailed;
static Class GBInstalledDelegate;
static NSDictionary *GBDevicePushState;
static NSString *GBDevicePushStateIdentity;
static char GBOriginalSwitchTargets;
static char GBHiddenPushEntryKey;
static NSString *GBPushStateKey(void) {
  return [@"GrokBotLocal.pushState." stringByAppendingString:
    [NSUserDefaults.standardUserDefaults stringForKey:@"GrokBotLocal.deviceId"] ?: @"unpaired"];
}
static void GBPushDiagnostic(NSString *event, NSDictionary *values) {
  static BOOL capture;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ capture = getenv("GROKBOT_VALIDATE_CAPTURE") != NULL; });
  if (!capture) return;
  NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"HostValidation"];
  [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSMutableDictionary *report = [values mutableCopy]; report[@"event"] = event;
  [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil]
      writeToURL:[dir URLByAppendingPathComponent:[@"push-" stringByAppendingFormat:@"%@.json",event]] atomically:YES];
}
static NSString *GBAuthName(UNAuthorizationStatus value) {
  switch (value) {
  case UNAuthorizationStatusDenied: return @"denied";
  case UNAuthorizationStatusAuthorized: return @"authorized";
  case UNAuthorizationStatusProvisional: return @"provisional";
  case UNAuthorizationStatusEphemeral: return @"ephemeral";
  default: return @"notDetermined";
  }
}
static NSString *GBReadPushEnvironment(void) {
  // Query the running process's actual code-signing entitlement, not its profile
  // and not the separate user-notification authorization setting.
  typedef CFTypeRef (*Create)(CFAllocatorRef);
  typedef CFTypeRef (*Copy)(CFTypeRef, CFStringRef, CFErrorRef *);
  Create create = (Create)dlsym(RTLD_DEFAULT, "SecTaskCreateFromSelf");
  Copy copy = (Copy)dlsym(RTLD_DEFAULT, "SecTaskCopyValueForEntitlement");
  if (!create || !copy) return nil;
  CFTypeRef task = create(kCFAllocatorDefault);
  if (!task) return nil;
  id value = CFBridgingRelease(copy(task, CFSTR("aps-environment"), NULL));
  CFRelease(task);
  return [value isEqual:@"development"] || [value isEqual:@"production"] ? value : nil;
}
NSString *GBPushEnvironment(void) {
  static NSString *environment;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ environment = GBReadPushEnvironment(); });
  return environment;
}
static UIViewController *GBPushTop(void) {
  UIViewController *top;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow) top = w.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}
static void GBDeviceRequest(NSString *method, NSDictionary *body,
                            void (^done)(NSDictionary *, NSError *)) {
  NSString *base = GBConnection.shared.serverURL, *token = GBConnection.shared.deviceToken;
  NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:@"/local/device"]] : nil;
  if (!url || !token.length) {
    if (done) {
      NSError *err = [NSError errorWithDomain:@"GrokBotDevice" code:401 userInfo:nil];
      dispatch_async(dispatch_get_main_queue(), ^{ done(nil, err); });
    }
    return;
  }
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url];
  r.HTTPMethod = method; r.timeoutInterval = 15;
  [r setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[GBHTTPSession() dataTaskWithRequest:r completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSDictionary *value = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
    NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
        ? ((NSHTTPURLResponse *)response).statusCode : 0;
    if (!error && (status < 200 || status >= 300 || !value))
      error = [NSError errorWithDomain:@"GrokBotDevice" code:status userInfo:nil];
    GBPushDiagnostic(@"request", @{@"method":method,@"status":@(status),@"errorDomain":error.domain ?: @"",@"errorCode":@(error.code),@"responseError":[value[@"error"] isKindOfClass:NSString.class] ? value[@"error"] : @""});
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![base isEqual:GBConnection.shared.serverURL] || ![token isEqual:GBConnection.shared.deviceToken]) {
        if (done) done(nil, [NSError errorWithDomain:@"GrokBotDevice" code:NSURLErrorCancelled userInfo:nil]);
        return;
      }
      if (!error && [value[@"push"] isKindOfClass:NSDictionary.class]) {
        // Persist only display state, never push tokens, URLs, or JSON nulls.
        NSDictionary *push = value[@"push"];
        NSString *provider = [push[@"provider"] isKindOfClass:NSString.class] ? push[@"provider"] : @"none";
        NSString *authorization = [push[@"authorization"] isKindOfClass:NSString.class] ? push[@"authorization"] : @"notDetermined";
        BOOL configured = [push[@"configured"] isKindOfClass:NSNumber.class] && [push[@"configured"] boolValue];
        BOOL enabled = [push[@"enabled"] isKindOfClass:NSNumber.class] && [push[@"enabled"] boolValue];
        NSDictionary *nextState = @{
          @"provider": provider,
          @"configured": configured ? @YES : @NO,
          @"enabled": enabled ? @YES : @NO,
          @"authorization": authorization
        };
        NSString *key = GBPushStateKey();
        if (![key isEqualToString:GBDevicePushStateIdentity] || ![nextState isEqualToDictionary:GBDevicePushState]) {
          GBDevicePushState = nextState;
          GBDevicePushStateIdentity = key;
          [NSUserDefaults.standardUserDefaults setObject:GBDevicePushState forKey:key];
          [NSNotificationCenter.defaultCenter postNotificationName:@"GrokBotPushStateChanged" object:nil];
        }
      }
      if (done) done(value, error);
    });
  }] resume];
}
static void GBReportDevice(UNNotificationSettings *settings) {
  NSString *environment = GBPushEnvironment();
  GBPushDiagnostic(@"registration", @{@"environment":environment ?: (id)NSNull.null,@"authorization":GBAuthName(settings.authorizationStatus),@"tokenPresent":@(GBAPNsToken.length > 0),@"registrationError":GBRegistrationError ?: @""});
  NSMutableDictionary *body = [@{
    @"name": UIDevice.currentDevice.name ?: @"",
    @"kind": UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad ? @"ipad" : @"iphone",
    @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
    @"appVersion": [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
    // Objective-C comparison expressions box as NSNumber(int), which JSON
    // encodes as 0/1. The Host correctly requires a JSON boolean here.
    @"apnsCapable": environment ? @YES : @NO,
    @"apnsEnvironment": environment ?: NSNull.null,
    @"authorization": GBAuthName(settings.authorizationStatus)
  } mutableCopy];
  if (environment && GBAPNsToken.length)
    body[@"push"] = @{ @"provider": @"apns", @"token": GBAPNsToken, @"registrationError": NSNull.null };
  else if (GBRegistrationError)
    body[@"push"] = @{ @"registrationError": GBRegistrationError };
  else if (!environment)
    body[@"push"] = @{ @"registrationError": NSNull.null };
  GBDeviceRequest(@"PUT", body, nil);
}
void GBPushSetForeground(BOOL foreground) {
  if (!GBConnection.shared.deviceToken.length) return;
  __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
  void (^endTask)(void) = ^{
    void (^finish)(void) = ^{
      if (task != UIBackgroundTaskInvalid) {
        UIBackgroundTaskIdentifier current = task;
        task = UIBackgroundTaskInvalid;
        [UIApplication.sharedApplication endBackgroundTask:current];
      }
    };
    if ([NSThread isMainThread]) finish();
    else dispatch_async(dispatch_get_main_queue(), finish);
  };
  if (!foreground)
    task = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Host notification state"
                                                      expirationHandler:endTask];
  GBDeviceRequest(@"PUT", @{@"foreground":foreground ? @YES : @NO}, ^(NSDictionary *value, NSError *error) {
    GBDiagnosticsEvent(@"presence.report", @{@"foreground":foreground ? @YES : @NO, @"success":error ? @NO : @YES});
    endTask();
  });
}
static BOOL GBClaimNotification(NSString *identity) {
  NSString *base = GBConnection.shared.serverURL;
  if (!base.length || !identity.length) return NO;
  NSMutableDictionary *all = [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"GrokBotLocal.notificationSeen"] mutableCopy] ?: [NSMutableDictionary new];
  NSMutableArray *seen = [all[base] mutableCopy] ?: [NSMutableArray new];
  if ([seen containsObject:identity]) return NO;
  [seen addObject:identity];
  while (seen.count > 256) [seen removeObjectAtIndex:0];
  all[base] = seen;
  [NSUserDefaults.standardUserDefaults setObject:all forKey:@"GrokBotLocal.notificationSeen"];
  return YES;
}
void GBReceiveLocalNotification(NSDictionary *n) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *identity = n[@"notificationId"] ?: n[@"id"];
    if (![identity isKindOfClass:NSString.class] || !GBClaimNotification(identity)) return;
    // The original PushPayload.foregroundBehavior suppresses task-completion
    // banners. Conversation state continues through the existing Gateway stream.
    // Keep receipts/deduplication without adding a separate completion UI.
    GBDiagnosticsEvent(@"notification.foregroundReceipt", @{ @"agentId": n[@"agentId"] ?: @"" });
  });
}
@interface GBPushDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> original;
@end
@implementation GBPushDelegate
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector { return self.original; }
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)n
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))done {
  NSDictionary *payload = n.request.content.userInfo;
  if ([payload[@"notificationId"] isKindOfClass:NSString.class]) {
    GBDiagnosticsEvent(@"notification.foreground", @{@"agentId":payload[@"agentId"] ?: @""});
    GBReceiveLocalNotification(payload); done(UNNotificationPresentationOptionNone); return;
  }
  if ([self.original respondsToSelector:_cmd])
    [self.original userNotificationCenter:center willPresentNotification:n withCompletionHandler:done];
  else done(UNNotificationPresentationOptionNone);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))done {
  NSDictionary *p = response.notification.request.content.userInfo;
  if ([p[@"notificationId"] isKindOfClass:NSString.class]) {
    GBDiagnosticsEvent(@"notification.response", @{@"agentId":p[@"agentId"] ?: @"", @"action":response.actionIdentifier ?: @""});
    GBClaimNotification(p[@"notificationId"]);
    GBOpenAgent(p[@"agentId"]); done(); return;
  }
  if ([self.original respondsToSelector:_cmd])
    [self.original userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:done];
  else done();
}
@end
static GBPushDelegate *GBNotificationDelegate;
static IMP GBOriginalSetNotificationDelegate;
static void GBSetNotificationDelegate(id self, SEL cmd, id<UNUserNotificationCenterDelegate> delegate) {
  if (!GBNotificationDelegate) GBNotificationDelegate = [GBPushDelegate new];
  if (delegate != GBNotificationDelegate) GBNotificationDelegate.original = delegate;
  ((void (*)(id,SEL,id))GBOriginalSetNotificationDelegate)(self,cmd,GBNotificationDelegate);
}
__attribute__((constructor)) static void GBObserveNotificationDelegate(void) {
  // iOS may deliver a cold-start response before didBecomeActive/registration.
  // Wrap the first delegate assignment, while preserving unrelated notifications.
  Method method = class_getInstanceMethod(UNUserNotificationCenter.class, @selector(setDelegate:));
  if (method) GBOriginalSetNotificationDelegate = method_setImplementation(method,(IMP)GBSetNotificationDelegate);
}
static void GBRegistered(id self, SEL cmd, UIApplication *app, NSData *token) {
  if (!GBConnection.shared.deviceToken.length) {
    if (GBOriginalRegistered) ((void (*)(id,SEL,id,id))GBOriginalRegistered)(self,cmd,app,token);
    return;
  }
  const unsigned char *bytes = token.bytes;
  NSMutableString *value = [NSMutableString stringWithCapacity:token.length * 2];
  for (NSUInteger i=0; i<token.length; i++) [value appendFormat:@"%02x",bytes[i]];
  GBAPNsToken = value; GBRegistrationError = nil;
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    dispatch_async(dispatch_get_main_queue(), ^{ GBReportDevice(s); });
  }];
}
static void GBFailed(id self, SEL cmd, UIApplication *app, NSError *error) {
  if (!GBConnection.shared.deviceToken.length) {
    if (GBOriginalFailed) ((void (*)(id,SEL,id,id))GBOriginalFailed)(self,cmd,app,error);
    return;
  }
  // The original app can request APNs even in a wildcard-signed Bark build.
  // That expected missing-entitlement error is unrelated to Bark delivery.
  if (!GBPushEnvironment()) { GBRegistrationError = nil; return; }
  GBRegistrationError = [NSString stringWithFormat:@"%@ (%ld)",error.domain,(long)error.code];
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    dispatch_async(dispatch_get_main_queue(), ^{ GBReportDevice(s); });
  }];
}
static IMP GBHook(Class cls, SEL selector, IMP replacement) {
  Method method = class_getInstanceMethod(cls, selector);
  IMP original = method ? method_getImplementation(method) : NULL;
  const char *types = method ? method_getTypeEncoding(method) : "v@:@@";
  class_replaceMethod(cls, selector, replacement, types); return original;
}
static void GBInstallPushDelegate(void) {
  Class cls = object_getClass(UIApplication.sharedApplication.delegate);
  if (cls && GBInstalledDelegate != cls) {
    GBOriginalRegistered = GBHook(cls, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:), (IMP)GBRegistered);
    GBOriginalFailed = GBHook(cls, @selector(application:didFailToRegisterForRemoteNotificationsWithError:), (IMP)GBFailed);
    GBInstalledDelegate = cls;
  }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  if (!GBNotificationDelegate) GBNotificationDelegate = [GBPushDelegate new];
  if (center.delegate != GBNotificationDelegate) {
    GBNotificationDelegate.original = center.delegate; center.delegate = GBNotificationDelegate;
  }
}
static NSString *GBPromptKey(void) {
  return [@"GrokBotLocal.barkPrompt." stringByAppendingString:
    [NSUserDefaults.standardUserDefaults stringForKey:@"GrokBotLocal.deviceId"] ?: @"unpaired"];
}
static void GBShowBark(void) {
  if (GBPromptVisible || !GBConnection.shared.deviceToken.length) return;
  UIViewController *top = GBPushTop();
  if (!top || [top isKindOfClass:UIAlertController.class] || top.beingDismissed) return;
  GBPromptVisible = YES;
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:GBL(@"接收通知", @"Notifications")
    message:GBL(@"粘贴 Bark 推送链接", @"Paste your Bark notification URL")
    preferredStyle:UIAlertControllerStyleAlert];
  [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
    field.placeholder = @"https://api.day.app/…"; field.keyboardType = UIKeyboardTypeURL;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.autocorrectionType = UITextAutocorrectionTypeNo; field.secureTextEntry = YES;
  }];
  [alert addAction:[UIAlertAction actionWithTitle:GBL(@"稍后", @"Not now") style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) {
    GBPromptVisible = NO; [NSUserDefaults.standardUserDefaults setBool:YES forKey:GBPromptKey()];
  }]];
  __weak UIAlertController *weakAlert = alert;
  [alert addAction:[UIAlertAction actionWithTitle:GBL(@"保存", @"Save") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
    GBPromptVisible = NO;
    NSString *input = weakAlert.textFields.firstObject.text;
    GBDeviceRequest(@"PUT", @{ @"push": @{ @"provider": @"bark", @"barkUrl": input ?: @"" } }, ^(NSDictionary *value, NSError *error) {
      if (!error) { [NSUserDefaults.standardUserDefaults setBool:YES forKey:GBPromptKey()]; return; }
      UIAlertController *failed = [UIAlertController alertControllerWithTitle:GBL(@"未能保存", @"Could not save")
        message:GBL(@"请检查 Bark 链接和服务端连接。", @"Check the Bark URL and Host connection.") preferredStyle:UIAlertControllerStyleAlert];
      [failed addAction:[UIAlertAction actionWithTitle:GBL(@"重试", @"Retry") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { GBShowBark(); }]];
      [failed addAction:[UIAlertAction actionWithTitle:GBL(@"稍后", @"Not now") style:UIAlertActionStyleCancel handler:nil]];
      UIViewController *presenter = GBPushTop();
      if (presenter && ![presenter isKindOfClass:UIAlertController.class] && !presenter.beingDismissed)
        [presenter presentViewController:failed animated:YES completion:nil];
    });
  }]];
  [top presentViewController:alert animated:YES completion:nil];
}
void GBPushShowSettings(void) {
  if (!GBPushEnvironment()) { GBShowBark(); return; }
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:UIApplicationOpenSettingsURLString] options:@{} completionHandler:nil];
}
@interface GBPushEntry : UIButton
@property(nonatomic, weak) UISwitch *originalSwitch;
@property(nonatomic, strong) UILabel *stateLabel;
@property(nonatomic, strong) UIImageView *chevron;
@end
@implementation GBPushEntry
- (void)open { GBPushShowSettings(); }
+ (void)changed:(UISwitch *)control {
  if (!GBPushEnvironment()) { GBPushShowSettings(); return; }
  BOOL requested = control.on;
  control.enabled = NO;
  void (^save)(BOOL) = ^(BOOL enabled) {
    GBDeviceRequest(@"PUT", @{@"push":@{@"enabled":enabled ? @YES : @NO}}, ^(NSDictionary *value, NSError *error) {
      control.enabled = YES;
      if (error) control.on = !requested;
      if (enabled && !error) GBPushRefresh();
    });
  };
  if (!requested) { save(NO); return; }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert|UNAuthorizationOptionSound|UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
          dispatch_async(dispatch_get_main_queue(), ^{ control.on = granted; save(granted); });
        }];
      } else if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
        control.enabled = YES; control.on = NO; GBPushShowSettings();
      } else save(YES);
    });
  }];
}
@end
static UISwitch *GBNotificationSwitch(UIView *view) {
  UISwitch *control = [view isKindOfClass:UISwitch.class] ? (UISwitch *)view : nil;
  if (!control)
    for (UIView *child in view.subviews)
      if ([child isKindOfClass:UISwitch.class]) { control = (UISwitch *)child; break; }
  return control;
}
static void GBAssociateHiddenPushEntry(UISwitch *control, GBPushEntry *entry) {
  if (!control) return;
  if (!entry) {
    objc_setAssociatedObject(control, &GBHiddenPushEntryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return;
  }
  NSHashTable<GBPushEntry *> *box = objc_getAssociatedObject(control, &GBHiddenPushEntryKey);
  if (box && box.anyObject == entry) return;
  box = [NSHashTable weakObjectsHashTable];
  [box addObject:entry];
  objc_setAssociatedObject(control, &GBHiddenPushEntryKey, box, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
void GBResetPushView(UIView *view) {
  UISwitch *control = GBNotificationSwitch(view);
  NSMapTable *targets = control ? objc_getAssociatedObject(control, &GBOriginalSwitchTargets) : nil;
  if (targets) {
    [control removeTarget:GBPushEntry.class action:@selector(changed:) forControlEvents:UIControlEventValueChanged];
    for (id target in targets)
      for (NSString *action in [targets objectForKey:target])
        [control addTarget:target action:NSSelectorFromString(action) forControlEvents:UIControlEventValueChanged];
    objc_setAssociatedObject(control, &GBOriginalSwitchTargets, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  NSHashTable<GBPushEntry *> *hiddenBox = control ? objc_getAssociatedObject(control, &GBHiddenPushEntryKey) : nil;
  if (hiddenBox) {
    GBPushEntry *linked = hiddenBox.anyObject;
    objc_setAssociatedObject(control, &GBHiddenPushEntryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (control.hidden) control.hidden = NO;
    if ([linked isKindOfClass:GBPushEntry.class] && linked.originalSwitch == control) {
      linked.originalSwitch = nil;
      [linked removeFromSuperview];
    }
  }
  GBPushEntry *entry = (GBPushEntry *)[view viewWithTag:731990];
  if ([entry isKindOfClass:GBPushEntry.class]) {
    UISwitch *orig = entry.originalSwitch;
    if (orig) {
      objc_setAssociatedObject(orig, &GBHiddenPushEntryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (orig.hidden) orig.hidden = NO;
      entry.originalSwitch = nil;
    }
    [entry removeFromSuperview];
  }
}
BOOL GBReplacePushView(UIView *view) {
  if (!GBConnection.shared.isPaired) return NO;
  UISwitch *control = GBNotificationSwitch(view);
  static NSSet<NSString *> *switchLabels;
  static NSSet<NSString *> *authorizedStates;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    switchLabels = [NSSet setWithArray:@[@"通知", @"Notifications"]];
    authorizedStates = [NSSet setWithArray:@[@"authorized", @"provisional", @"ephemeral"]];
  });
  if (!control || !control.accessibilityLabel.length || ![switchLabels containsObject:control.accessibilityLabel]) return NO;
  // Scope global push replacement to the App Settings screen so per-Bot
  // "Notifications" toggles inside Bot Settings keep their native behavior.
  if (!GBIsGlobalSettingsContext(view)) {
    if (objc_getAssociatedObject(control, &GBOriginalSwitchTargets) != nil ||
        objc_getAssociatedObject(control, &GBHiddenPushEntryKey) != nil)
      GBResetPushView(view);
    return NO;
  }
  NSString *identity = GBPushStateKey();
  NSDictionary *state = [GBDevicePushStateIdentity isEqual:identity] ? GBDevicePushState :
    [NSUserDefaults.standardUserDefaults dictionaryForKey:identity];
  if (GBPushEnvironment()) {
    if (!objc_getAssociatedObject(control, &GBOriginalSwitchTargets)) {
      NSMapTable *targets = NSMapTable.weakToStrongObjectsMapTable;
      for (id target in control.allTargets) {
        NSArray *actions = [control actionsForTarget:target forControlEvent:UIControlEventValueChanged];
        if (actions.count) [targets setObject:actions forKey:target];
      }
      objc_setAssociatedObject(control, &GBOriginalSwitchTargets, targets, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      [control removeTarget:nil action:nil forControlEvents:UIControlEventValueChanged];
      [control addTarget:GBPushEntry.class action:@selector(changed:) forControlEvents:UIControlEventValueChanged];
      GBTrackModifiedView(view);
      GBTrackModifiedView(control);
    }
    if (state && control.enabled) {
      BOOL shouldBeOn = [state[@"enabled"] boolValue] &&
          [state[@"authorization"] isKindOfClass:NSString.class] &&
          [authorizedStates containsObject:state[@"authorization"]];
      if (control.on != shouldBeOn) control.on = shouldBeOn;
    }
    return YES;
  }
  UIView *row = control.superview;
  while (row && row.bounds.size.width < 300) row = row.superview;
  if (!row || row.bounds.size.height < 40) return NO;
  // Fabric flattens all setting rows into one group. Derive this row from the
  // native switch's position, preserving Appearance/Language rows below it.
  CGRect switchRect = [control convertRect:control.bounds toView:row];
  CGFloat height = MAX(50, switchRect.size.height + 30);
  CGRect rowFrame = CGRectMake(0, MAX(0, CGRectGetMidY(switchRect) - height / 2), row.bounds.size.width, height);
  GBPushEntry *entry = (GBPushEntry *)[row viewWithTag:731990];
  if (!entry) {
    entry = [GBPushEntry buttonWithType:UIButtonTypeCustom];
    entry.tag = 731990; entry.originalSwitch = control;
    entry.frame = rowFrame;
    entry.autoresizingMask = UIViewAutoresizingFlexibleWidth;
    entry.stateLabel = [UILabel new]; entry.stateLabel.font = [UIFont systemFontOfSize:17];
    entry.stateLabel.textColor = UIColor.secondaryLabelColor; entry.stateLabel.textAlignment = NSTextAlignmentRight;
    entry.chevron = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"chevron.right"]];
    entry.chevron.tintColor = UIColor.tertiaryLabelColor;
    [entry addSubview:entry.stateLabel]; [entry addSubview:entry.chevron];
    [entry addTarget:entry action:@selector(open) forControlEvents:UIControlEventTouchUpInside];
    if (!row.userInteractionEnabled) row.userInteractionEnabled = YES;
    [row addSubview:entry];
  } else {
    if (entry.originalSwitch != control) {
      UISwitch *previous = entry.originalSwitch;
      if (previous) {
        GBAssociateHiddenPushEntry(previous, nil);
        if (previous.hidden) previous.hidden = NO;
      }
      entry.originalSwitch = control;
    }
    if (!CGRectEqualToRect(entry.frame, rowFrame)) entry.frame = rowFrame;
  }
  GBAssociateHiddenPushEntry(control, entry);
  GBTrackModifiedView(row);
  GBTrackModifiedView(view);
  GBTrackModifiedView(control);
  if (!control.hidden) control.hidden = YES;
  if (entry.layer.zPosition != 1000) entry.layer.zPosition = 1000;
  if (row.subviews.lastObject != entry) [row bringSubviewToFront:entry];
  BOOL configured = [state[@"provider"] isEqual:@"bark"] && [state[@"configured"] boolValue];
  NSString *stateText = configured ? GBL(@"Bark 已配置", @"Bark configured") : GBL(@"Bark 未配置", @"Bark not configured");
  if (![entry.stateLabel.text isEqualToString:stateText]) entry.stateLabel.text = stateText;
  CGRect labelFrame = CGRectMake(entry.bounds.size.width - 204, (entry.bounds.size.height - 22) / 2, 160, 22);
  if (!CGRectEqualToRect(entry.stateLabel.frame, labelFrame)) entry.stateLabel.frame = labelFrame;
  CGRect chevronFrame = CGRectMake(entry.bounds.size.width - 34, (entry.bounds.size.height - 16) / 2, 10, 16);
  if (!CGRectEqualToRect(entry.chevron.frame, chevronFrame)) entry.chevron.frame = chevronFrame;
  NSString *entryLabel = [GBL(@"通知，", @"Notifications, ") stringByAppendingString:stateText];
  if (![entry.accessibilityLabel isEqualToString:entryLabel]) entry.accessibilityLabel = entryLabel;
  return YES;
}
void GBPushRefresh(void) {
  if (!GBConnection.shared.deviceToken.length) return;
  GBInstallPushDelegate();
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    dispatch_async(dispatch_get_main_queue(), ^{
      GBReportDevice(s);
      if (GBPushEnvironment()) {
        if (s.authorizationStatus == UNAuthorizationStatusNotDetermined && !GBAuthorizing && !GBAuthorizationAttempted) {
          GBAuthorizing = YES; GBAuthorizationAttempted = YES;
          [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert|UNAuthorizationOptionSound|UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
              GBAuthorizing = NO;
              if (error) GBRegistrationError = [NSString stringWithFormat:@"%@ (%ld)",error.domain,(long)error.code];
              GBPushRefresh();
            });
          }];
        } else [UIApplication.sharedApplication registerForRemoteNotifications];
      } else if (![NSUserDefaults.standardUserDefaults boolForKey:GBPromptKey()]) {
        GBDeviceRequest(@"GET", nil, ^(NSDictionary *value, NSError *error) {
          if (error) return;
          NSDictionary *push = [value[@"push"] isKindOfClass:NSDictionary.class] ? value[@"push"] : nil;
          if ([push[@"configured"] isKindOfClass:NSNumber.class] && [push[@"configured"] boolValue])
            [NSUserDefaults.standardUserDefaults setBool:YES forKey:GBPromptKey()];
          else GBShowBark();
        });
      }
    });
  }];
}
