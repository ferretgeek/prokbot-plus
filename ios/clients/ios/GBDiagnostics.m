// Opt-in validation, enabled by a launch variable or an explicit local marker.
// Captures this app's own window and records loaded image names without secrets.
#import "GBConnection.h"
#import "GBDiagnostics.h"
#import "GBPush.h"
#import <UIKit/UIKit.h>
#import <mach-o/dyld.h>
#import <CommonCrypto/CommonDigest.h>
#import <dlfcn.h>
#import <sys/sysctl.h>
#import <objc/runtime.h>
#import <stdatomic.h>
static NSDictionary *GBLoadedBundle;
static atomic_bool GBDiagnosticsActive;
static void *GBTaskTimingContext = &GBTaskTimingContext;
static BOOL GBValidateCaptureEnv(void) {
  static BOOL enabled;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ enabled = getenv("GROKBOT_VALIDATE_CAPTURE") != NULL; });
  return enabled;
}
static NSURL *GBValidationDirectory(void) {
  return [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject
      URLByAppendingPathComponent:@"HostValidation" isDirectory:YES];
}
BOOL GBDiagnosticsEnabled(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    BOOL active = GBValidateCaptureEnv();
    if (!active) {
      NSURL *directory = GBValidationDirectory();
      active = directory != nil &&
          [NSFileManager.defaultManager fileExistsAtPath:
            [directory URLByAppendingPathComponent:@"enable-notification-diagnostics"].path];
    }
    atomic_store_explicit(&GBDiagnosticsActive, active, memory_order_relaxed);
    if (!GBValidateCaptureEnv()) {
      [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
                                                      object:nil
                                                       queue:nil
                                                  usingBlock:^(NSNotification *n) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
          NSURL *dir = GBValidationDirectory();
          BOOL enabled = dir != nil &&
              [NSFileManager.defaultManager fileExistsAtPath:
                [dir URLByAppendingPathComponent:@"enable-notification-diagnostics"].path];
          atomic_store_explicit(&GBDiagnosticsActive, enabled, memory_order_relaxed);
        });
      }];
    }
  });
  return atomic_load_explicit(&GBDiagnosticsActive, memory_order_relaxed);
}
@interface GBTaskTiming : NSObject {
  atomic_bool _removed;
}
- (BOOL)claimRemoval;
@end
@implementation GBTaskTiming
- (BOOL)claimRemoval {
  return !atomic_exchange(&_removed, true);
}
- (void)observeValueForKeyPath:(NSString *)path ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  if (context != GBTaskTimingContext) {
    [super observeValueForKeyPath:path ofObject:object change:change context:context];
    return;
  }
  NSURLSessionTask *task = object;
  if (task.state != NSURLSessionTaskStateCompleted) return;
  if (![self claimRemoval]) return;
  NSInteger status = [task.response isKindOfClass:NSHTTPURLResponse.class]
      ? ((NSHTTPURLResponse *)task.response).statusCode : 0;
  GBDiagnosticsEvent(@"network.taskComplete", @{@"path":task.originalRequest.URL.path ?: @"", @"status":@(status), @"error":@(task.error.code)});
  [task removeObserver:self forKeyPath:@"state" context:GBTaskTimingContext];
  objc_setAssociatedObject(task, GBTaskTimingContext, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
@end
void GBDiagnosticsObserveTask(NSURLSessionTask *task) {
  if (!GBValidateCaptureEnv() || !task || task.state == NSURLSessionTaskStateCompleted) return;
  GBTaskTiming *observer = [GBTaskTiming new];
  objc_setAssociatedObject(task, GBTaskTimingContext, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [task addObserver:observer forKeyPath:@"state" options:NSKeyValueObservingOptionNew context:GBTaskTimingContext];
  if (task.state == NSURLSessionTaskStateCompleted && [observer claimRemoval]) {
    [task removeObserver:observer forKeyPath:@"state" context:GBTaskTimingContext];
    objc_setAssociatedObject(task, GBTaskTimingContext, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}
static IMP GBOriginalNetworkComplete, GBOriginalSplashReady;
typedef void (^GBRCTFatalHandler)(NSError *);
static GBRCTFatalHandler GBPreviousFatalHandler;
static IMP GBOriginalReportFatalException;
static IMP GBOriginalReportSoftException;
static IMP GBOriginalReportException;
static IMP GBOriginalReportFatal;
static IMP GBOriginalReportSoft;
static void GBReportFatal(id self, SEL selector, NSString *message, NSArray *stack,
                          double exceptionId, NSString *extraDataAsJSON) {
  GBDiagnosticsEvent(@"javascript.fatal", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[],
    @"exceptionId": @(exceptionId),
    @"extraDataAsJSON": extraDataAsJSON ?: @""
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double, NSString *))GBOriginalReportFatal)(
      self, selector, message, stack, exceptionId, extraDataAsJSON);
}
static void GBReportSoft(id self, SEL selector, NSString *message, NSArray *stack,
                         double exceptionId, NSString *extraDataAsJSON) {
  GBDiagnosticsEvent(@"javascript.soft", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[],
    @"exceptionId": @(exceptionId),
    @"extraDataAsJSON": extraDataAsJSON ?: @""
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double, NSString *))GBOriginalReportSoft)(
      self, selector, message, stack, exceptionId, extraDataAsJSON);
}
static void GBFatal(id self, SEL selector, NSString *message, NSArray *stack, double exceptionId) {
  GBDiagnosticsEvent(@"javascript.fatal", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[]
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double))GBOriginalReportFatalException)(
      self, selector, message, stack, exceptionId);
}
static void GBSoft(id self, SEL selector, NSString *message, NSArray *stack, double exceptionId) {
  GBDiagnosticsEvent(@"javascript.soft", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[]
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double))GBOriginalReportSoftException)(
      self, selector, message, stack, exceptionId);
}
static void GBReport(id self, SEL selector, void *data) {
  GBDiagnosticsEvent(@"javascript.exception", @{});
  ((void (*)(id, SEL, void *))GBOriginalReportException)(self, selector, data);
}
static void GBSplashReady(id self, SEL selector) {
  GBDiagnosticsEvent(@"splash.appReady", @{});
  ((void (*)(id,SEL))GBOriginalSplashReady)(self,selector);
}
static void GBNetworkComplete(id self, SEL selector, NSURLSession *session, NSURLSessionTask *task, NSError *error) {
  NSInteger status = [task.response isKindOfClass:NSHTTPURLResponse.class]
      ? ((NSHTTPURLResponse *)task.response).statusCode : 0;
  GBDiagnosticsEvent(@"network.complete", @{@"path":task.originalRequest.URL.path ?: @"", @"status":@(status), @"error":@(error.code)});
  ((void (*)(id,SEL,id,id,id))GBOriginalNetworkComplete)(self,selector,session,task,error);
}
static BOOL GBContainsReadyLabel(UIView *view, NSString *label) {
  if (view.hidden || view.alpha < .01) return NO;
  NSString *value = [view isKindOfClass:UILabel.class] ? ((UILabel *)view).text : view.accessibilityLabel;
  if ([value containsString:label]) return YES;
  for (UIView *child in view.subviews) if (GBContainsReadyLabel(child, label)) return YES;
  return NO;
}
void GBDiagnosticsEvent(NSString *event, NSDictionary *values) {
  if (!GBDiagnosticsEnabled()) return;
  NSURL *directory = GBValidationDirectory();
  if (!directory) return;
  @synchronized (GBConnection.class) {
    [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *file = [directory URLByAppendingPathComponent:@"notification-events.json"];
    NSData *old = [NSData dataWithContentsOfURL:file];
    NSMutableArray *events = old ? [[NSJSONSerialization JSONObjectWithData:old options:NSJSONReadingMutableContainers error:nil] mutableCopy] : nil;
    if (![events isKindOfClass:NSMutableArray.class]) events = [NSMutableArray new];
    if ([event isEqual:@"bootstrap.begin"]) {
      struct kinfo_proc process = {0}; size_t length = sizeof(process);
      int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
      if (sysctl(mib, 4, &process, &length, NULL, 0) == 0 && length)
        values = @{@"processStartedAt":@((double)process.kp_proc.p_starttime.tv_sec + process.kp_proc.p_starttime.tv_usec / 1e6)};
    }
    [events addObject:@{@"event":event, @"values":values ?: @{}, @"pid":@(getpid()),
      @"time":@([NSDate.date timeIntervalSince1970])}];
    while (events.count > 256) [events removeObjectAtIndex:0];
    [[NSJSONSerialization dataWithJSONObject:events options:NSJSONWritingPrettyPrinted error:nil] writeToURL:file atomically:YES];
  }
}
static NSDictionary *GBBundleDescription(NSURL *url) {
  NSString *kind = [url.path hasPrefix:NSBundle.mainBundle.bundlePath] ? @"embedded" :
      [url.lastPathComponent isEqual:GBConnection.shared.gatewayBundleURL.lastPathComponent] ? @"paired" : @"external-cache";
  NSMutableDictionary *result = [@{@"kind":kind, @"file":url.lastPathComponent ?: @""} mutableCopy];
  if (![kind isEqual:@"paired"] && url.isFileURL) {
    NSData *data = [NSData dataWithContentsOfURL:url];
    if (data && data.length <= UINT_MAX) {
      unsigned char digest[CC_SHA256_DIGEST_LENGTH];
      CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
      NSMutableString *hex = [NSMutableString new];
      for (NSUInteger i=0; i<sizeof(digest); i++) [hex appendFormat:@"%02x",digest[i]];
      result[@"sha256"] = hex;
    }
  }
  return result;
}
void GBDiagnosticsRecordBundle(NSURL *requested, NSURL *loaded) {
  GBDiagnosticsEvent(@"bundle.load", @{@"requested":requested.lastPathComponent ?: @"", @"loaded":loaded.lastPathComponent ?: @""});
  if (GBValidateCaptureEnv())
    GBLoadedBundle = @{@"requested":GBBundleDescription(requested), @"loaded":GBBundleDescription(loaded)};
}
static void *GBResolveReactSymbol(const char *symbolName) {
  void *sym = dlsym(RTLD_DEFAULT, symbolName);
  if (sym) return sym;
  const char *classImage = class_getImageName(NSClassFromString(@"RCTExceptionsManager"));
  if (classImage) {
    void *image = dlopen(classImage, RTLD_LAZY | RTLD_NOLOAD);
    if (image) {
      sym = dlsym(image, symbolName);
      dlclose(image);
      if (sym) return sym;
    }
  }
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *path = _dyld_get_image_name(i);
    if (!path || !strstr(path, "/React.framework/React")) continue;
    void *image = dlopen(path, RTLD_LAZY | RTLD_NOLOAD);
    if (image) {
      sym = dlsym(image, symbolName);
      dlclose(image);
      if (sym) return sym;
    }
  }
  return NULL;
}
__attribute__((constructor)) static void GBInstallDiagnostics(void) {
  if (!GBValidateCaptureEnv())
    return;
  typedef void (*GBSetFatalHandler)(GBRCTFatalHandler);
  typedef GBRCTFatalHandler (*GBGetFatalHandler)(void);
  GBSetFatalHandler setFatalHandler =
      (GBSetFatalHandler)GBResolveReactSymbol("RCTSetFatalHandler");
  GBGetFatalHandler getFatalHandler =
      (GBGetFatalHandler)GBResolveReactSymbol("RCTGetFatalHandler");
  if (setFatalHandler) {
    GBPreviousFatalHandler = getFatalHandler ? getFatalHandler() : nil;
    setFatalHandler(^(NSError *error) {
      GBDiagnosticsEvent(@"native.fatal", @{
        @"domain": error.domain ?: @"",
        @"code": @(error.code),
        @"reason": error.localizedDescription ?: @""
      });
      if (GBPreviousFatalHandler) {
        GBPreviousFatalHandler(error);
      } else {
        // Match React Native's default fatal handler by raising an NSException
        // instead of swallowing the fatal error during validation runs.
        [NSException raise:@"RCTFatalException"
                    format:@"Unhandled React Native fatal error: %@",
                           error.localizedDescription ?: @"(unknown)"];
      }
    });
  }
  Class exceptions = NSClassFromString(@"RCTExceptionsManager");
  Method fatalWithExtra = class_getInstanceMethod(
      exceptions, NSSelectorFromString(@"reportFatal:stack:exceptionId:extraDataAsJSON:"));
  Method softWithExtra = class_getInstanceMethod(
      exceptions, NSSelectorFromString(@"reportSoft:stack:exceptionId:extraDataAsJSON:"));
  Method fatal = class_getInstanceMethod(
      exceptions, @selector(reportFatalException:stack:exceptionId:));
  Method soft = class_getInstanceMethod(
      exceptions, @selector(reportSoftException:stack:exceptionId:));
  Method report = class_getInstanceMethod(exceptions, @selector(reportException:));
  if (fatalWithExtra)
    GBOriginalReportFatal = method_setImplementation(fatalWithExtra, (IMP)GBReportFatal);
  if (softWithExtra)
    GBOriginalReportSoft = method_setImplementation(softWithExtra, (IMP)GBReportSoft);
  if (fatal) GBOriginalReportFatalException = method_setImplementation(fatal, (IMP)GBFatal);
  if (soft) GBOriginalReportSoftException = method_setImplementation(soft, (IMP)GBSoft);
  if (report) GBOriginalReportException = method_setImplementation(report, (IMP)GBReport);
  Method networkComplete = class_getInstanceMethod(NSClassFromString(@"RCTHTTPRequestHandler"), @selector(URLSession:task:didCompleteWithError:));
  if (networkComplete) GBOriginalNetworkComplete = method_setImplementation(networkComplete,(IMP)GBNetworkComplete);
  for (NSString *name in @[@"RCTJavaScriptWillStartLoadingNotification", @"RCTJavaScriptWillStartExecutingNotification", @"RCTJavaScriptDidLoadNotification", @"RCTContentDidAppearNotification"])
    [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *n) {
      GBDiagnosticsEvent(@"react.lifecycle", @{@"name":name});
    }];
  Class splash = NSClassFromString(@"_TtC16ExpoSplashScreen19SplashScreenManager");
  Method ready = class_getInstanceMethod(splash, NSSelectorFromString(@"onAppReady"));
  if (ready) GBOriginalSplashReady = method_setImplementation(ready, (IMP)GBSplashReady);
  unsigned int count = 0; Method *methods = class_copyMethodList(splash, &count);
  NSMutableArray *selectors = [NSMutableArray new];
  for (unsigned int i=0; i<count; i++)
    [selectors addObject:@{@"selector":NSStringFromSelector(method_getName(methods[i])), @"type":[NSString stringWithUTF8String:method_getTypeEncoding(methods[i])]}];
  free(methods);
  GBDiagnosticsEvent(@"splash.methods", @{@"methods":selectors});
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *label = [NSString stringWithContentsOfURL:[GBValidationDirectory() URLByAppendingPathComponent:@"expected-ready-label"] encoding:NSUTF8StringEncoding error:nil];
    if (!label.length) return;
    __block NSUInteger ticks = 0;
    [NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer *timer) {
      if (++ticks > 600) { [timer invalidate]; return; }
      for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
        if ([s isKindOfClass:UIWindowScene.class])
          for (UIWindow *w in ((UIWindowScene *)s).windows)
            if (w.isKeyWindow && GBContainsReadyLabel(w, label)) {
              GBDiagnosticsEvent(@"ui.ready", @{@"label":label});
              UIGraphicsImageRenderer *r = [[UIGraphicsImageRenderer alloc] initWithBounds:w.bounds];
              UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *context) { [w drawViewHierarchyInRect:w.bounds afterScreenUpdates:NO]; }];
              [UIImagePNGRepresentation(image) writeToURL:[GBValidationDirectory() URLByAppendingPathComponent:@"ready.png"] atomically:YES];
              [timer invalidate]; return;
            }
    }];
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    UIWindow *window = nil;
    for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
      if ([s isKindOfClass:UIWindowScene.class])
        for (UIWindow *w in ((UIWindowScene *)s).windows)
          if (w.isKeyWindow)
            window = w;
    if (!window)
      return;
    UIGraphicsImageRenderer *renderer =
        [[UIGraphicsImageRenderer alloc] initWithBounds:window.bounds];
    UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
      [window drawViewHierarchyInRect:window.bounds afterScreenUpdates:NO];
    }];
    NSURL *directory = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory
                                                             inDomains:NSUserDomainMask]
                            .firstObject URLByAppendingPathComponent:@"HostValidation"
                                                         isDirectory:YES];
    [NSFileManager.defaultManager
               createDirectoryAtURL:directory
        withIntermediateDirectories:YES
                         attributes:@{
                           NSFileProtectionKey :
                               NSFileProtectionCompleteUntilFirstUserAuthentication
                         }
                              error:nil];
    [UIImagePNGRepresentation(image)
        writeToURL:[directory URLByAppendingPathComponent:@"cold-start.png"]
        atomically:YES];
    NSMutableArray *images = [NSMutableArray new];
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
      const char *path = _dyld_get_image_name(i);
      if (path)
        [images addObject:[[NSString stringWithUTF8String:path] lastPathComponent]];
    }
    NSDictionary *report = @{
      @"capturedAt" : @([NSDate.date timeIntervalSince1970]),
      @"apnsEnvironment" : GBPushEnvironment() ?: (id)NSNull.null,
      @"bundleId" : NSBundle.mainBundle.bundleIdentifier,
      @"paired" : @(GBConnection.shared.deviceToken.length > 0),
      @"gatewayReady" : @(GBConnection.shared.gatewayBundleURL != nil),
      @"script" : GBLoadedBundle ?: @{},
      @"images" : images
    };
    [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil]
        writeToURL:[directory URLByAppendingPathComponent:@"cold-start.json"]
        atomically:YES];
  });
}
