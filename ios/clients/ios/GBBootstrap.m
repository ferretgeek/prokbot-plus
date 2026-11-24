#import "GBComputers.h"
#import "GBConnection.h"
#import "GBAppIntents.h"
#import "GBLibrary.h"
#import "GBNotifications.h"
#import "GBProfile.h"
#import "GBPush.h"
#import "GBConnectors.h"
#import "GBDeepLinks.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"
#import "GBUsage.h"
#import "GBNetwork.h"
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static IMP GBOriginalLoad;
static __weak id GBHost;
static BOOL GBLoadedPairedBundle;
static UIWindow *GBWindow(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow)
          return window;
  return nil;
}
static id GBIvar(id object, const char *name) {
  if (!object)
    return nil;
  Ivar ivar = class_getInstanceVariable(object_getClass(object), name);
  return ivar ? object_getIvar(object, ivar) : nil;
}
static id GBFindHost(void) {
  id delegate = UIApplication.sharedApplication.delegate;
  return GBIvar(GBIvar(GBIvar(delegate, "reactNativeFactory"), "_rootViewFactory"), "_reactHost");
}
static void GBLoad(id self, SEL cmd, NSURL *url, id progress, id completion) {
  GBHost = self;
  BOOL useEmbeddedBundle = [NSProcessInfo.processInfo.environment[@"GROKBOT_VALIDATE_EMBEDDED_BUNDLE"] boolValue];
  NSURL *paired = GBConnection.shared.gatewayBundleURL;
  NSURL *loaded = useEmbeddedBundle ? url : (paired ?: url);
  GBLoadedPairedBundle = paired != nil && !useEmbeddedBundle;
  GBDiagnosticsRecordBundle(url, loaded);
  GBDiagnosticsEvent(@"bundle.mode", @{@"embedded":@(useEmbeddedBundle), @"paired":@(paired != nil)});
  ((void (*)(id, SEL, NSURL *, id, id))GBOriginalLoad)(self, cmd, loaded, progress,
                                                       completion);
}
void GBReloadReactHost(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    GBDiagnosticsEvent(@"react.reload", @{});
    id host = GBHost ?: GBFindHost();
    SEL reload = sel_registerName("didReceiveReloadCommand");
    if ([host respondsToSelector:reload])
      ((void (*)(id, SEL))objc_msgSend)(host, reload);
  });
}
static NSSet<NSString *> *GBPrimaryLoginLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"Sign in with Apple", @"通过 Apple 登录", @"透過 Apple 登入",
      @"Log in", @"Login", @"Sign in", @"登录", @"登入", @"登陆",
      @"登录或注册", @"Log in or sign up",
      @"连接服务端", @"Connect to Host"
    ]];
  });
  return set;
}
static NSSet<NSString *> *GBSecondaryLoginLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"Continue with Google", @"用 Google 账号继续", @"使用 Google 繼續",
      @"Continue with X", @"用 X 账号继续", @"使用 X 繼續",
      @"Continue with email", @"用邮箱继续", @"使用電子郵件繼續",
      @"Continue with phone", @"用手机号继续", @"使用電話號碼繼續",
      @"Sign in with work account", @"Sign in with your work account",
      @"Sign in with SuperGrok", @"使用 SuperGrok 登录", @"使用 SuperGrok 登入",
      @"Sign in to Grok Bot"
    ]];
  });
  return set;
}
static NSSet<NSString *> *GBSignOutLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"Sign out", @"Log out", @"退出登录", @"登出", @"退出登入", @"退出账号", @"退出账户"
    ]];
  });
  return set;
}
static NSSet<NSString *> *GBUsageLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"用量", @"Usage"]]; });
  return set;
}
static NSSet<NSString *> *GBDebugLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"调试", @"Debug"]]; });
  return set;
}
static NSSet<NSString *> *GBLibraryLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"资料库", @"Library"]]; });
  return set;
}
static NSSet<NSString *> *GBComputerLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"Bot 电脑", @"Bot Computer"]]; });
  return set;
}
static NSSet<NSString *> *GBToolbarHostLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[@"调试", @"Debug", @"link", @"连接 Host", @"Host Connection"]];
  });
  return set;
}
static NSSet<NSString *> *GBTouchHostLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"连接服务端", @"Connect to Host"]]; });
  return set;
}
static Class GBFabricViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTViewComponentView"); });
  return cls;
}
static BOOL GBCaptureEnabled(void) {
  static BOOL enabled;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ enabled = getenv("GROKBOT_VALIDATE_CAPTURE") != NULL; });
  return enabled;
}
static BOOL GBIsPluginTag(NSInteger tag) {
  return tag >= 731988 && tag <= 731999;
}
static NSString *GBStripPluginLabelSuffix(NSString *label, UIView *view) {
  if (!label.length) return label;
  NSString *result = label;
  for (UIView *child in view.subviews.reverseObjectEnumerator) {
    if (!GBIsPluginTag(child.tag)) continue;
    NSString *candidates[2] = {
      child.accessibilityLabel,
      [child isKindOfClass:UIButton.class] ? [((UIButton *)child) titleForState:UIControlStateNormal] : nil
    };
    for (int i = 0; i < 2; i++) {
      NSString *childLabel = [candidates[i] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (!childLabel.length) continue;
      NSString *suffix = [@", " stringByAppendingString:childLabel];
      if (result.length > suffix.length && [result hasSuffix:suffix]) {
        result = [[result substringToIndex:result.length - suffix.length]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        break;
      }
    }
  }
  return result;
}
static BOOL GBHasAncestorPluginTag(UIView *view, NSInteger tag) {
  for (UIView *v = view.superview; v; v = v.superview) {
    if (v.tag == tag) return YES;
    for (UIView *sub in v.subviews)
      if (sub.tag == tag) return YES;
  }
  return NO;
}
static BOOL GBSubtreeHasStyledHostButton(UIView *root, UIView *excluding) {
  if (!root || root == excluding || root.hidden || root.alpha < 0.01) return NO;
  if (root.tag == 731991 && [root isKindOfClass:UIButton.class]) {
    UIButton *btn = (UIButton *)root;
    if (btn.configuration != nil) return YES;
  }
  for (UIView *child in root.subviews) {
    if (GBSubtreeHasStyledHostButton(child, excluding)) return YES;
  }
  return NO;
}
static NSSet<NSString *> *GBSettingsContextLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"dev-gateway@localhost", @"dev-gateway@localhost avatar",
      @"Auto-review", @"自动审查", @"自動審查",
      @"Appearance", @"外观", @"外觀",
      @"Language", @"语言", @"語言",
      @"Usage", @"用量",
      @"Bot 电脑", @"Bot Computer"
    ]];
  });
  return set;
}
static BOOL GBSubtreeContainsSettingsMarker(UIView *root, NSSet<NSString *> *markers, NSUInteger depth) {
  if (!root || root.hidden || root.alpha < 0.01 || depth > 24) return NO;
  if (root.tag == 731993 || root.tag == 731989) return YES;
  NSString *raw = [root isKindOfClass:UILabel.class] ? ((UILabel *)root).text : root.accessibilityLabel;
  if (raw.length && raw.length <= 64) {
    NSString *trimmed = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if ([markers containsObject:trimmed]) return YES;
  }
  for (UIView *child in root.subviews) {
    if (GBSubtreeContainsSettingsMarker(child, markers, depth + 1)) return YES;
  }
  return NO;
}
static BOOL GBIsSettingsSignOutContext(UIView *view) {
  // Scope Sign out interception to the enclosing Settings/Account screen
  // controller so similarly labeled buttons inside Connected Apps or OAuth
  // sub-screens cannot accidentally disconnect the Host.
  UIView *scope = nil;
  for (UIResponder *responder = view.nextResponder; responder; responder = responder.nextResponder) {
    if ([responder isKindOfClass:UIViewController.class]) {
      scope = ((UIViewController *)responder).view;
      break;
    }
  }
  if (!scope) scope = view.window;
  if (!scope) return NO;
  return GBSubtreeContainsSettingsMarker(scope, GBSettingsContextLabels(), 0);
}
static void GBClearHostSettingsIdentifier(UIView *view) {
  if ([view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
    view.accessibilityIdentifier = nil;
}
@interface GBInterface : NSObject
+ (void)showConnection;
+ (void)confirmSignOut;
+ (void)refresh;
@end
@implementation GBInterface
+ (void)showLibrary {
  GBShowLibrary();
}
+ (void)showComputers {
  GBShowComputers();
}
+ (void)showConnection {
  [GBConnection.shared show];
}
+ (void)confirmSignOut {
  UIViewController *top = GBTopController();
  if (!top) {
    [GBConnection.shared disconnect];
    return;
  }
  if ([top isKindOfClass:UIAlertController.class])
    return;
  UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:GBL(@"退出登录？", @"Sign out?")
                       message:GBL(@"将清除本机的 Host 地址与配对凭证，重新打开后需要重新连接 Host。",
                                   @"This clears the saved Host address and pairing credential from this device.")
                preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:GBL(@"取消", @"Cancel")
                                            style:UIAlertActionStyleCancel
                                          handler:nil]];
  [alert addAction:[UIAlertAction actionWithTitle:GBL(@"退出登录", @"Sign out")
                                            style:UIAlertActionStyleDestructive
                                          handler:^(UIAlertAction *action) {
                                            [GBConnection.shared disconnect];
                                          }]];
  [top presentViewController:alert animated:YES completion:nil];
}
+ (void)installHostButtonOn:(UIView *)view styled:(BOOL)styled {
  UIButton *existing = (UIButton *)[view viewWithTag:731991];
  if (existing) {
    if (!CGRectEqualToRect(existing.frame, view.bounds)) {
      existing.frame = view.bounds;
      if (existing.configuration != nil) {
        CGFloat radius = MIN(view.bounds.size.height / 2.0, 26.0);
        if (existing.layer.cornerRadius != radius) existing.layer.cornerRadius = radius;
      }
    }
    return;
  }
  UIButton *button = [UIButton buttonWithType:styled ? UIButtonTypeSystem : UIButtonTypeCustom];
  button.tag = 731991;
  button.frame = view.bounds;
  button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  button.accessibilityIdentifier = @"grokbot.host.settings";
  button.accessibilityLabel = GBL(@"连接 Host", @"Connect to Host");
  if (styled) {
    UIButtonConfiguration *config = UIButtonConfiguration.filledButtonConfiguration;
    config.title = GBL(@"连接 Host", @"Connect to Host");
    config.image = [UIImage systemImageNamed:@"link"];
    config.imagePadding = 8;
    config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    config.baseBackgroundColor = UIColor.labelColor;
    config.baseForegroundColor = UIColor.systemBackgroundColor;
    button.configuration = config;
    button.layer.cornerRadius = MIN(view.bounds.size.height / 2.0, 26.0);
    button.clipsToBounds = YES;
  }
  [button addTarget:self
                action:@selector(showConnection)
      forControlEvents:UIControlEventTouchUpInside];
  if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
  [view addSubview:button];
}
+ (void)replaceEntry:(UIView *)view {
  if (GBIsPluginTag(view.tag))
    return;
  BOOL hasPluginChild = NO;
  UISwitch *directSwitch = [view isKindOfClass:UISwitch.class] ? (UISwitch *)view : nil;
  for (UIView *child in view.subviews) {
    if (GBIsPluginTag(child.tag)) hasPluginChild = YES;
    if (!directSwitch && [child isKindOfClass:UISwitch.class]) directSwitch = (UISwitch *)child;
  }
  NSString *rawLabel = nil;
  if ([view isKindOfClass:UIButton.class])
    rawLabel = [((UIButton *)view) titleForState:UIControlStateNormal];
  else if ([view isKindOfClass:UILabel.class])
    rawLabel = ((UILabel *)view).text;
  else
    rawLabel = view.accessibilityLabel;
  if (!hasPluginChild && !directSwitch && (rawLabel.length == 0 || rawLabel.length > 96)) {
    if (view.accessibilityIdentifier != nil) GBClearHostSettingsIdentifier(view);
    return;
  }
  NSString *label = [rawLabel stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (hasPluginChild && label.length)
    label = GBStripPluginLabelSuffix(label, view);
  if (!hasPluginChild && !directSwitch && !label.length) {
    if (view.accessibilityIdentifier != nil) GBClearHostSettingsIdentifier(view);
    return;
  }
  GBObserveAppLanguage(label);
  NSSet<NSString *> *primaryLogin = GBPrimaryLoginLabels();
  NSSet<NSString *> *secondaryLogin = GBSecondaryLoginLabels();
  NSSet<NSString *> *signOutLabels = GBSignOutLabels();
  NSSet<NSString *> *usageLabels = GBUsageLabels();
  NSSet<NSString *> *debugLabels = GBDebugLabels();
  NSSet<NSString *> *libraryLabels = GBLibraryLabels();
  NSSet<NSString *> *computerLabels = GBComputerLabels();
  BOOL paired = GBConnection.shared.deviceToken.length > 0;
  BOOL checkedSettingsSignOut = NO;
  BOOL isSettingsSignOut = NO;
  if (hasPluginChild) {
    NSMutableArray<UIView *> *stale = nil;
    for (UIView *child in view.subviews) {
      NSInteger tag = child.tag;
      if (!GBIsPluginTag(tag)) continue;
      BOOL remove = NO;
      if (tag == 731988) {
        if (!paired || ![signOutLabels containsObject:label]) {
          remove = YES;
        } else {
          if (!checkedSettingsSignOut) {
            isSettingsSignOut = GBIsSettingsSignOutContext(view);
            checkedSettingsSignOut = YES;
          }
          if (!isSettingsSignOut) remove = YES;
        }
      } else if (tag == 731989 && ![usageLabels containsObject:label]) {
        remove = YES;
      } else if (tag == 731991 &&
                 (paired || (![primaryLogin containsObject:label] && ![secondaryLogin containsObject:label] &&
                             ![debugLabels containsObject:label]))) {
        remove = YES;
      } else if (tag == 731992 && ![libraryLabels containsObject:label]) {
        remove = YES;
      } else if (tag == 731993 && ![label isEqualToString:@"dev-gateway@localhost"] &&
                 ![label isEqualToString:@"dev-gateway@localhost avatar"]) {
        remove = YES;
      } else if (tag == 731999 && ![computerLabels containsObject:label]) {
        remove = YES;
      }
      if (remove) {
        if (!stale) stale = [NSMutableArray array];
        [stale addObject:child];
      }
    }
    for (UIView *child in stale) {
      if (child.tag == 731991) GBClearHostSettingsIdentifier(view);
      else if (child.tag == 731993) GBResetProfileView(view);
      [child removeFromSuperview];
    }
  }
  if ([label hasPrefix:@"dev-gateway@localhost"] && GBReplaceProfileView(view))
    return;
  if (directSwitch && GBReplacePushView(view))
    return;
  Class fabricViewClass = GBFabricViewClass();
  BOOL isFabricView = fabricViewClass && [view isKindOfClass:fabricViewClass];
  if (isFabricView && paired && [signOutLabels containsObject:label] &&
      view.bounds.size.width >= 60 && view.bounds.size.height >= 36) {
    if (!checkedSettingsSignOut) {
      isSettingsSignOut = GBIsSettingsSignOutContext(view);
      checkedSettingsSignOut = YES;
    }
    if (isSettingsSignOut) {
      UIButton *existing = (UIButton *)[view viewWithTag:731988];
      if (existing) {
        if (!CGRectEqualToRect(existing.frame, view.bounds)) existing.frame = view.bounds;
        NSString *signOutLabel = GBL(@"退出登录", @"Sign out");
        if (![existing.accessibilityLabel isEqualToString:signOutLabel])
          existing.accessibilityLabel = signOutLabel;
      } else {
        UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
        button.tag = 731988;
        button.frame = view.bounds;
        button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        button.accessibilityIdentifier = @"grokbot.host.signout";
        button.accessibilityLabel = GBL(@"退出登录", @"Sign out");
        [button addTarget:self
                      action:@selector(confirmSignOut)
            forControlEvents:UIControlEventTouchUpInside];
        if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
        [view addSubview:button];
      }
      return;
    }
  }
  if (isFabricView && !paired && [primaryLogin containsObject:label] && view.bounds.size.width >= 160 &&
      view.bounds.size.height >= 40) {
    if (GBHasAncestorPluginTag(view, 731991))
      return;
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    if ([view viewWithTag:731991]) {
      [self installHostButtonOn:view styled:NO];
    } else {
      BOOL useStyled = !GBSubtreeHasStyledHostButton(view.window, view);
      [self installHostButtonOn:view styled:useStyled];
    }
    return;
  }
  if (isFabricView && !paired && [secondaryLogin containsObject:label] && view.bounds.size.width >= 160 &&
      view.bounds.size.height >= 40) {
    if (GBHasAncestorPluginTag(view, 731991))
      return;
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    [self installHostButtonOn:view styled:NO];
    return;
  }
  if ([computerLabels containsObject:label] && view.bounds.size.width > 300 &&
      view.bounds.size.height >= 44) {
    UIButton *existing = (UIButton *)[view viewWithTag:731999];
    if (existing) {
      if (!CGRectEqualToRect(existing.frame, view.bounds)) existing.frame = view.bounds;
    } else {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731999;
      button.frame = view.bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityLabel = GBL(@"Bot 电脑", @"Bot Computer");
      [button addTarget:self
                    action:@selector(showComputers)
          forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
      [view addSubview:button];
    }
    return;
  }
  if (!paired &&
      [debugLabels containsObject:label] && view.bounds.size.width > 200 &&
      view.bounds.size.height >= 40) {
    // Unpaired full-width Debug entry opens local Host setup.
    if (GBHasAncestorPluginTag(view, 731991))
      return;
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    [self installHostButtonOn:view styled:NO];
    return;
  }
  if ([GBToolbarHostLabels() containsObject:label] && paired && view.bounds.size.width <= 88) {
    // Keep the original toolbar and link icon; only route the original touch.
    NSString *hostLabel = GBL(@"连接 Host", @"Host Connection");
    if (![view.accessibilityLabel isEqualToString:hostLabel])
      view.accessibilityLabel = hostLabel;
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    return;
  }
  if (view.accessibilityIdentifier != nil)
    GBClearHostSettingsIdentifier(view);
  if ([libraryLabels containsObject:label] && paired &&
      view.bounds.size.width > 20) {
    UIButton *existing = (UIButton *)[view viewWithTag:731992];
    if (existing) {
      if (!CGRectEqualToRect(existing.frame, view.bounds)) existing.frame = view.bounds;
    } else {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
      button.tag = 731992;
      button.frame = view.bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.backgroundColor = view.backgroundColor ?: UIColor.clearColor;
      [button setTitle:GBL(@"资料库", @"Library") forState:UIControlStateNormal];
      button.titleLabel.font = [UIFont systemFontOfSize:14];
      [button setTitleColor:UIColor.secondaryLabelColor forState:UIControlStateNormal];
      [button addTarget:self
                    action:@selector(showLibrary)
          forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
      [view addSubview:button];
    }
    return;
  }
  if ([usageLabels containsObject:label])
    GBReplaceUsageView(view);
}
+ (void)replaceLogin:(UIView *)view {
  [self replaceEntry:view];
  if (GBIsPluginTag(view.tag)) return;
  for (UIView *child in view.subviews) [self replaceLogin:child];
}
+ (void)refresh {
  UIWindow *window = GBWindow();
  if (!window)
    return;
  [self replaceLogin:window];
}

@end
static IMP GBOriginalTask;
static IMP GBOriginalSimpleTask;
static IMP GBOriginalTouches;
static IMP GBOriginalRecycle;
static IMP GBOriginalLayout;
static NSTimer *GBPresenceTimer;
static NSTimer *GBNetworkHealthTimer;
static BOOL GBStartupRefreshed;
static void GBEnsureNetworkReadyAsync(void) {
  if (!GBNetworkEnabled()) return;
  NSString *serverURL = GBConnection.shared.serverURL;
  if (!serverURL.length) return;
  NSURL *url = [NSURL URLWithString:serverURL];
  if (!url) return;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    GBNetworkEnsureReadyForURL(url);
  });
}
static void GBStopForegroundTimers(void) {
  [GBPresenceTimer invalidate];
  GBPresenceTimer = nil;
  [GBNetworkHealthTimer invalidate];
  GBNetworkHealthTimer = nil;
}
static void GBStartForegroundTimers(void) {
  if (!GBPresenceTimer) {
    GBPresenceTimer = [NSTimer scheduledTimerWithTimeInterval:25 repeats:YES block:^(NSTimer *timer) {
      if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
        GBPushSetForeground(YES);
    }];
    GBPresenceTimer.tolerance = 5.0;
  }
  if (GBNetworkEnabled()) {
    if (!GBNetworkHealthTimer) {
      // Inspect cached transport health only while active. This also recovers a
      // stale peer when the original UI is waiting without making new requests.
      GBNetworkHealthTimer = [NSTimer scheduledTimerWithTimeInterval:5 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
          GBEnsureNetworkReadyAsync();
      }];
      GBNetworkHealthTimer.tolerance = 1.0;
    }
  } else if (GBNetworkHealthTimer) {
    [GBNetworkHealthTimer invalidate];
    GBNetworkHealthTimer = nil;
  }
}
static void GBLayout(id self, SEL selector) {
  ((void (*)(id, SEL))GBOriginalLayout)(self, selector);
  // Fabric has populated labels and bounds at this point, before the first
  // frame is displayed. Update the affected view here, without polling the
  // entire window while the interface is idle.
  [GBInterface replaceEntry:self];
}
static void GBRecycle(id self, SEL selector) {
  GBResetProfileView(self);
  GBResetPushView(self);
  if ([self accessibilityIdentifier] != nil)
    GBClearHostSettingsIdentifier(self);
  NSMutableArray<UIView *> *stale = nil;
  for (UIView *child in [self subviews]) {
    if (GBIsPluginTag(child.tag)) {
      if (!stale) stale = [NSMutableArray array];
      [stale addObject:child];
    }
  }
  for (UIView *child in stale)
    [child removeFromSuperview];
  ((void (*)(id, SEL))GBOriginalRecycle)(self, selector);
}
static void GBTouches(id self, SEL selector, NSSet<UITouch *> *touches, UIEvent *event) {
  // Fabric handles ancestor touches even when a native button receives them.
  // Exclude plugin controls first so native buttons handle TouchUpInside cleanly.
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if (GBIsPluginTag(v.tag))
        return;
  NSSet<NSString *> *touchHostLabels = GBTouchHostLabels();
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if ([touchHostLabels containsObject:v.accessibilityLabel] || [v.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"] || ([v.accessibilityLabel isEqualToString:@"link"] && GBConnection.shared.deviceToken.length)) {
        [GBConnection.shared show];
        return;
      }
  ((void (*)(id, SEL, id, id))GBOriginalTouches)(self, selector, touches, event);
}
static id GBSimpleTask(id self, SEL selector, NSURLRequest *request) {
  BOOL networkReady = GBNetworkEnsureReadyForURL(request.URL);
  if (GBDiagnosticsEnabled())
    GBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  GBObserveRequest(request);
  id task = ((id (*)(id, SEL, id))GBOriginalSimpleTask)(self, selector, request);
  if (!networkReady) [task cancel];
  else if (GBCaptureEnabled()) GBDiagnosticsObserveTask(task);
  return task;
}
static id GBTask(id self, SEL selector, NSURLRequest *request, id completion) {
  BOOL networkReady = GBNetworkEnsureReadyForURL(request.URL);
  if (GBDiagnosticsEnabled())
    GBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  GBObserveRequest(request);
  if (GBCaptureEnabled() && completion) {
    void (^original)(NSData *, NSURLResponse *, NSError *) = completion;
    completion = ^(NSData *data, NSURLResponse *response, NSError *error) {
      NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
          ? ((NSHTTPURLResponse *)response).statusCode : 0;
      GBDiagnosticsEvent(@"network.complete", @{@"path":request.URL.path ?: @"", @"status":@(status), @"error":@(error.code)});
      original(data, response, error);
    };
  }
  id task = ((id (*)(id, SEL, id, id))GBOriginalTask)(self, selector, request, completion);
  if (!networkReady) [task cancel];
  return task;
}
static void GBInstall(void) {
  GBInstallDeepLinks();
  if (!GBOriginalLayout) {
    Class cls = NSClassFromString(@"RCTViewComponentView");
    Method method = class_getInstanceMethod(cls, @selector(layoutSubviews));
    if (method) {
      GBOriginalLayout = method_getImplementation(method);
      class_replaceMethod(cls, @selector(layoutSubviews), (IMP)GBLayout, method_getTypeEncoding(method));
    }
  }
  if (!GBOriginalRecycle) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTViewComponentView"),
                                            sel_registerName("prepareForRecycle"));
    if (method)
      GBOriginalRecycle = method_setImplementation(method, (IMP)GBRecycle);
  }
  if (!GBOriginalTouches) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTSurfaceTouchHandler"),
                                            @selector(touchesBegan:withEvent:));
    if (method)
      GBOriginalTouches = method_setImplementation(method, (IMP)GBTouches);
  }
  if (!GBOriginalSimpleTask) {
    Method method =
        class_getInstanceMethod(NSURLSession.class, sel_registerName("dataTaskWithRequest:"));
    if (method)
      GBOriginalSimpleTask = method_setImplementation(method, (IMP)GBSimpleTask);
  }
  if (!GBOriginalTask) {
    Method method = class_getInstanceMethod(
        NSURLSession.class, sel_registerName("dataTaskWithRequest:completionHandler:"));
    if (method)
      GBOriginalTask = method_setImplementation(method, (IMP)GBTask);
  }
  if (!GBOriginalLoad) {
    Method method = class_getInstanceMethod(
        NSClassFromString(@"RCTHost"), sel_registerName("loadBundleAtURL:onProgress:onComplete:"));
    if (method)
      GBOriginalLoad = method_setImplementation(method, (IMP)GBLoad);
  }
}
__attribute__((constructor)) static void GBInitialize(void) {
  @autoreleasepool {
    GBDiagnosticsEvent(@"bootstrap.begin", @{});
    Dl_info location = {0};
    dladdr((const void *)&GBInitialize, &location);
    NSString *libraryPath =
        location.dli_fname ? [NSString stringWithUTF8String:location.dli_fname] : nil;
    if (!libraryPath.length)
      return;
    GBConnection.shared.resourcesURL =
        [[NSURL fileURLWithPath:libraryPath.stringByDeletingLastPathComponent]
            URLByAppendingPathComponent:@"GrokBotLocal.bundle"
                            isDirectory:YES];
    NSError *error = nil;
    BOOL restored = [GBConnection.shared restore:&error];
    GBDiagnosticsEvent(@"connection.restore", @{@"restored":restored ? @YES : @NO});
    GBInstallConnectorTransport();
    GBInstall();
    // Restore before the app creates its first RCTHost. A delayed unconditional
    // reload discards the navigation established by a cold notification click.
    dispatch_async(dispatch_get_main_queue(), ^{
      GBEnsureNetworkReadyAsync();
      GBConnection.shared.didConnect = ^{
        GBSyncAppIntentCredentials();
        [[GBNotifications shared] start];
        BOOL active = UIApplication.sharedApplication.applicationState == UIApplicationStateActive;
        GBPushSetForeground(active);
        if (active) GBStartForegroundTimers();
        GBRefreshProfile();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ GBPushRefresh(); });
      };
      GBConnection.shared.didDisconnect = ^{
        [[GBNotifications shared] stop];
        if (GBNetworkHealthTimer) {
          [GBNetworkHealthTimer invalidate];
          GBNetworkHealthTimer = nil;
        }
      };
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      [center addObserverForName:UIApplicationDidBecomeActiveNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        GBStartupRefreshed = YES;
                        GBInstall();
                        GBEnsureNetworkReadyAsync();
                        GBSyncAppIntentCredentials();
                        [GBInterface refresh];
                        [[GBNotifications shared] start];
                        GBPushSetForeground(YES);
                        GBRefreshProfile();
                        GBPushRefresh();
                        GBStartForegroundTimers();
                      }];
      [center addObserverForName:UIApplicationDidEnterBackgroundNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        GBStopForegroundTimers();
                        [[GBNotifications shared] stop];
                        GBPushSetForeground(NO);
                      }];
      for (NSString *name in @[@"GrokBotProfileChanged", @"GrokBotPushStateChanged"])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { [GBInterface refresh]; }];
      if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
        GBStartForegroundTimers();
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (restored && GBHost && !GBLoadedPairedBundle) GBReloadReactHost();
        if (!GBStartupRefreshed) {
          GBStartupRefreshed = YES;
          [GBInterface refresh];
          if (restored) {
            [[GBNotifications shared] start];
            GBRefreshProfile();
            GBPushRefresh();
          }
        }
      });
    });
  }
}
