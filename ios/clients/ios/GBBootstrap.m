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
static Class GBSwitchViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTSwitchComponentView"); });
  return cls;
}
static Class GBScrollViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTScrollViewComponentView"); });
  return cls;
}
static Class GBImageViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTImageComponentView"); });
  return cls;
}
static NSHashTable<UIView *> *GBModifiedViews(void) {
  static NSHashTable<UIView *> *table;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    table = [[NSHashTable alloc] initWithOptions:NSHashTableWeakMemory | NSHashTableObjectPointerPersonality
                                        capacity:16];
  });
  return table;
}
void GBTrackModifiedView(UIView *view) {
  if (!view) return;
  [GBModifiedViews() addObject:view];
}
static BOOL GBIsTrackedModifiedView(UIView *view) {
  NSHashTable<UIView *> *table = GBModifiedViews();
  return view != nil && table.count > 0 && [table containsObject:view];
}
static void GBUntrackModifiedView(UIView *view) {
  if (!view) return;
  [GBModifiedViews() removeObject:view];
}
static NSSet<NSString *> *GBAllInterestingLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableSet<NSString *> *all = [NSMutableSet setWithCapacity:64];
    [all unionSet:GBPrimaryLoginLabels()];
    [all unionSet:GBSecondaryLoginLabels()];
    [all unionSet:GBSignOutLabels()];
    [all unionSet:GBUsageLabels()];
    [all unionSet:GBDebugLabels()];
    [all unionSet:GBLibraryLabels()];
    [all unionSet:GBComputerLabels()];
    [all unionSet:GBToolbarHostLabels()];
    [all addObject:@"dev-gateway@localhost"];
    [all addObject:@"dev-gateway@localhost avatar"];
    [all addObject:@"账户"];
    [all addObject:@"语言"];
    [all addObject:@"語言"];
    [all addObject:@"Account"];
    [all addObject:@"Language"];
    set = [all copy];
  });
  return set;
}
static NSString *GBTrimWhitespaceIfNeeded(NSString *raw) {
  NSUInteger len = raw.length;
  if (!len) return raw;
  unichar first = [raw characterAtIndex:0];
  unichar last = [raw characterAtIndex:len - 1];
  if (first > 0x20 && last > 0x20 && first < 0x7f && last < 0x7f)
    return raw;
  NSCharacterSet *ws = NSCharacterSet.whitespaceAndNewlineCharacterSet;
  if (![ws characterIsMember:first] && ![ws characterIsMember:last])
    return raw;
  return [raw stringByTrimmingCharactersInSet:ws];
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
static NSString *GBStripPluginLabelSuffixAtDepth(NSString *label, UIView *view, NSUInteger depth) {
  if (!label.length || !view || depth > 8) return label;
  NSString *result = label;
  for (UIView *child in view.subviews.reverseObjectEnumerator) {
    if (GBIsPluginTag(child.tag)) {
      NSString *candidates[2] = {
        child.accessibilityLabel,
        [child isKindOfClass:UIButton.class] ? [((UIButton *)child) titleForState:UIControlStateNormal] : nil
      };
      for (int i = 0; i < 2; i++) {
        NSString *childLabel = GBTrimWhitespaceIfNeeded(candidates[i]);
        if (!childLabel.length) continue;
        NSString *suffix = [@", " stringByAppendingString:childLabel];
        if (result.length > suffix.length && [result hasSuffix:suffix]) {
          result = GBTrimWhitespaceIfNeeded([result substringToIndex:result.length - suffix.length]);
          break;
        }
      }
      continue;
    }
    if (depth < 8 && child.subviews.count > 0)
      result = GBStripPluginLabelSuffixAtDepth(result, child, depth + 1);
  }
  return result;
}
static NSString *GBStripPluginLabelSuffix(NSString *label, UIView *view) {
  return GBStripPluginLabelSuffixAtDepth(label, view, 0);
}
static void GBClearHostSettingsIdentifier(UIView *view) {
  if ([view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
    view.accessibilityIdentifier = nil;
}
BOOL GBHasAncestorPluginTag(UIView *view, NSInteger tag) {
  for (UIView *v = view.superview; v; v = v.superview) {
    if (v.tag == tag) return YES;
    for (UIView *sub in v.subviews)
      if (sub.tag == tag) return YES;
  }
  return NO;
}
static void GBRemoveDescendantPluginTagAtDepth(UIView *view, NSInteger tag, NSUInteger depth) {
  if (!view || depth > 8) return;
  for (UIView *child in [view.subviews copy]) {
    if (child.tag == tag) continue;
    NSMutableArray<UIView *> *stale = nil;
    for (UIView *sub in child.subviews) {
      if (sub.tag == tag) {
        if (!stale) stale = [NSMutableArray array];
        [stale addObject:sub];
      }
    }
    for (UIView *sub in stale) {
      if (tag == 731991) GBClearHostSettingsIdentifier(child);
      else if (tag == 731993) GBResetProfileView(child);
      [sub removeFromSuperview];
    }
    if (stale.count) {
      BOOL stillModified = [child.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"];
      if (!stillModified) {
        for (UIView *rem in child.subviews) {
          if (GBIsPluginTag(rem.tag)) {
            stillModified = YES;
            break;
          }
        }
      }
      if (!stillModified) GBUntrackModifiedView(child);
    }
    GBRemoveDescendantPluginTagAtDepth(child, tag, depth + 1);
  }
}
void GBRemoveDescendantPluginTag(UIView *view, NSInteger tag) {
  GBRemoveDescendantPluginTagAtDepth(view, tag, 0);
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
      @"dev-gateway@localhost",
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
  if ((root.tag == 731993 && [root isKindOfClass:UIButton.class]) ||
      root.tag == 731989 || root.tag == 731999)
    return YES;
  NSString *raw = nil;
  if ([root isKindOfClass:UILabel.class]) {
    raw = ((UILabel *)root).text;
  } else if (root.bounds.size.height <= 240.0 && root.subviews.count <= 12) {
    raw = root.accessibilityLabel;
  }
  if (raw.length && raw.length <= 64) {
    NSString *trimmed = GBTrimWhitespaceIfNeeded(raw);
    if ([markers containsObject:trimmed]) return YES;
  }
  for (UIView *child in root.subviews) {
    if (GBSubtreeContainsSettingsMarker(child, markers, depth + 1)) return YES;
  }
  return NO;
}
static char GBSettingsContextCacheKey;
static char GBSettingsRescanPendingKey;
static uint64_t GBSettingsContextEpoch = 1;
static void GBInvalidateSettingsContextCache(void) {
  GBSettingsContextEpoch++;
}
static UIViewController *GBEnclosingViewController(UIView *view) {
  for (UIResponder *responder = view.nextResponder; responder; responder = responder.nextResponder) {
    if ([responder isKindOfClass:UIViewController.class])
      return (UIViewController *)responder;
  }
  return nil;
}
static BOOL GBSettingsContextCacheLookup(UIViewController *controller, BOOL *matchedOut, uint64_t *epochOut) {
  if (!controller) return NO;
  NSNumber *cached = objc_getAssociatedObject(controller, &GBSettingsContextCacheKey);
  if (!cached) return NO;
  uint64_t packed = cached.unsignedLongLongValue;
  if (matchedOut) *matchedOut = (packed & 1ULL) != 0;
  if (epochOut) *epochOut = packed >> 1;
  return YES;
}
GBSettingsContextState GBGlobalSettingsContextState(UIView *view) {
  // Scope global Settings interceptions (Sign out, global Push switch) to the
  // enclosing App Settings screen so similarly labeled controls in Bot Settings
  // or Connected Apps sub-screens cannot be hijacked. Cache both YES and NO per
  // view controller by refresh epoch so recycled controllers re-evaluate, and
  // preserve existing overlays when a view temporarily leaves the window.
  UIViewController *controller = GBEnclosingViewController(view);
  BOOL cachedMatched = NO;
  uint64_t cachedEpoch = 0;
  BOOL hasCached = GBSettingsContextCacheLookup(controller, &cachedMatched, &cachedEpoch);
  if (!view.window) {
    if (hasCached && cachedEpoch == GBSettingsContextEpoch)
      return cachedMatched ? GBSettingsContextYes : GBSettingsContextNo;
    return GBSettingsContextUnknown;
  }
  if (!controller || !controller.isViewLoaded) return GBSettingsContextNo;
  if (hasCached && cachedEpoch == GBSettingsContextEpoch)
    return cachedMatched ? GBSettingsContextYes : GBSettingsContextNo;
  BOOL matched = GBSubtreeContainsSettingsMarker(controller.view, GBSettingsContextLabels(), 0);
  uint64_t packed = (GBSettingsContextEpoch << 1) | (matched ? 1ULL : 0ULL);
  objc_setAssociatedObject(controller, &GBSettingsContextCacheKey, @(packed), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return matched ? GBSettingsContextYes : GBSettingsContextNo;
}
BOOL GBIsGlobalSettingsContext(UIView *view) {
  return GBGlobalSettingsContextState(view) == GBSettingsContextYes;
}
static GBSettingsContextState GBIsSettingsSignOutContext(UIView *view) {
  return GBGlobalSettingsContextState(view);
}
@interface GBInterface : NSObject
+ (void)showConnection;
+ (void)confirmSignOut;
+ (void)replaceLogin:(UIView *)view;
+ (void)refresh;
@end
static void GBNoteSettingsMarkerOnView(UIView *view) {
  if (!view || view.hidden || view.alpha < 0.01 || !view.window) return;
  UIViewController *controller = GBEnclosingViewController(view);
  if (!controller || !controller.isViewLoaded) return;
  BOOL cachedMatched = NO;
  uint64_t cachedEpoch = 0;
  BOOL hasCached = GBSettingsContextCacheLookup(controller, &cachedMatched, &cachedEpoch);
  if (hasCached && cachedMatched && cachedEpoch == GBSettingsContextEpoch)
    return;
  uint64_t packed = (GBSettingsContextEpoch << 1) | 1ULL;
  objc_setAssociatedObject(controller, &GBSettingsContextCacheKey, @(packed), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (hasCached && !cachedMatched) {
    // A switch or sign-out row laid out before this Settings marker mounted;
    // schedule one coalesced pass on this controller instead of waiting for refresh.
    if ([objc_getAssociatedObject(controller, &GBSettingsRescanPendingKey) boolValue]) return;
    objc_setAssociatedObject(controller, &GBSettingsRescanPendingKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    __weak UIViewController *weakController = controller;
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *strongController = weakController;
      if (!strongController) return;
      objc_setAssociatedObject(strongController, &GBSettingsRescanPendingKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (strongController.isViewLoaded && strongController.view.window)
        [GBInterface replaceLogin:strongController.view];
    });
  }
}
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
  GBTrackModifiedView(view);
}
+ (void)replaceEntry:(UIView *)view {
  if (GBIsPluginTag(view.tag))
    return;
  if ([view isKindOfClass:UISwitch.class]) {
    GBReplacePushView(view);
    return;
  }
  BOOL tracked = GBIsTrackedModifiedView(view);
  CGRect bounds = view.bounds;
  NSArray<UIView *> *subviews = view.subviews;
  NSUInteger childCount = subviews.count;
  // Fast push-switch check before touching accessibilityLabel (which is recursive on Fabric views).
  if (childCount > 0 && childCount <= 4) {
    for (UIView *child in subviews) {
      if ([child isKindOfClass:UISwitch.class]) {
        if (GBReplacePushView(view))
          return;
        break;
      }
    }
  }
  // Never invoke Fabric's recursive accessibilityLabel on zero-size/hairline views
  // or large list/scroll/screen containers (e.g. a Bot roster with dozens of rows).
  if (bounds.size.width < 8.0 || bounds.size.height < 8.0 ||
      bounds.size.height > 240.0 || childCount > 12) {
    if (tracked && (bounds.size.height > 240.0 || childCount > 12)) {
      if (view.accessibilityIdentifier != nil) GBClearHostSettingsIdentifier(view);
      NSMutableArray<UIView *> *stale = nil;
      for (UIView *child in subviews) {
        NSInteger tag = child.tag;
        if (GBIsPluginTag(tag) && tag != 731990) {
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
    return;
  }
  BOOL hasPluginChild = NO;
  if (tracked) {
    for (UIView *child in subviews) {
      if (GBIsPluginTag(child.tag)) {
        hasPluginChild = YES;
        break;
      }
    }
  }
  NSString *rawLabel = nil;
  if ([view isKindOfClass:UIButton.class])
    rawLabel = [((UIButton *)view) titleForState:UIControlStateNormal];
  else if ([view isKindOfClass:UILabel.class])
    rawLabel = ((UILabel *)view).text;
  else
    rawLabel = view.accessibilityLabel;
  if (!hasPluginChild) {
    if (rawLabel.length == 0 || rawLabel.length > 80) {
      if (tracked && view.accessibilityIdentifier != nil) GBClearHostSettingsIdentifier(view);
      return;
    }
    NSString *fastLabel = GBTrimWhitespaceIfNeeded(rawLabel);
    NSSet<NSString *> *interesting = GBAllInterestingLabels();
    if (!fastLabel.length || ![interesting containsObject:fastLabel]) {
      NSString *recovered = nil;
      if (fastLabel.length > 0 && GBModifiedViews().count > 0) {
        NSRange sep = [fastLabel rangeOfString:@", "];
        if (sep.location != NSNotFound && sep.location > 0 && sep.location <= 40) {
          NSString *prefix = GBTrimWhitespaceIfNeeded([fastLabel substringToIndex:sep.location]);
          if ([interesting containsObject:prefix]) {
            NSString *stripped = GBStripPluginLabelSuffix(fastLabel, view);
            if (![stripped isEqualToString:fastLabel] && [interesting containsObject:stripped])
              recovered = stripped;
          }
        }
      }
      if (!recovered) {
        if (tracked && view.accessibilityIdentifier != nil) GBClearHostSettingsIdentifier(view);
        return;
      }
      fastLabel = recovered;
    }
    rawLabel = fastLabel;
  }
  NSString *label = hasPluginChild ? GBTrimWhitespaceIfNeeded(rawLabel) : rawLabel;
  if (hasPluginChild && label.length)
    label = GBStripPluginLabelSuffix(label, view);
  if (!hasPluginChild && !label.length) {
    if (tracked && view.accessibilityIdentifier != nil) GBClearHostSettingsIdentifier(view);
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
  BOOL paired = GBConnection.shared.isPaired;
  BOOL checkedSettingsSignOut = NO;
  GBSettingsContextState settingsSignOutState = GBSettingsContextUnknown;
  if (hasPluginChild) {
    NSMutableArray<UIView *> *stale = nil;
    for (UIView *child in subviews) {
      NSInteger tag = child.tag;
      if (!GBIsPluginTag(tag)) continue;
      BOOL remove = NO;
      if (tag == 731988) {
        if (!paired || ![signOutLabels containsObject:label]) {
          remove = YES;
        } else {
          if (!checkedSettingsSignOut) {
            settingsSignOutState = GBIsSettingsSignOutContext(view);
            checkedSettingsSignOut = YES;
          }
          if (settingsSignOutState == GBSettingsContextNo) remove = YES;
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
  if ([GBSettingsContextLabels() containsObject:label])
    GBNoteSettingsMarkerOnView(view);
  if ([label hasPrefix:@"dev-gateway@localhost"] && GBReplaceProfileView(view))
    return;
  Class fabricViewClass = GBFabricViewClass();
  BOOL isFabricView = fabricViewClass && [view isKindOfClass:fabricViewClass];
  if (isFabricView && paired && [signOutLabels containsObject:label] &&
      bounds.size.width >= 60 && bounds.size.height >= 36) {
    if (GBHasAncestorPluginTag(view, 731988))
      return;
    if (!checkedSettingsSignOut) {
      settingsSignOutState = GBIsSettingsSignOutContext(view);
      checkedSettingsSignOut = YES;
    }
    if (settingsSignOutState == GBSettingsContextYes) {
      GBRemoveDescendantPluginTag(view, 731988);
      UIButton *existing = (UIButton *)[view viewWithTag:731988];
      if (existing) {
        if (!CGRectEqualToRect(existing.frame, bounds)) existing.frame = bounds;
        NSString *signOutLabel = GBL(@"退出登录", @"Sign out");
        if (![existing.accessibilityLabel isEqualToString:signOutLabel])
          existing.accessibilityLabel = signOutLabel;
      } else {
        UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
        button.tag = 731988;
        button.frame = bounds;
        button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        button.accessibilityIdentifier = @"grokbot.host.signout";
        button.accessibilityLabel = GBL(@"退出登录", @"Sign out");
        [button addTarget:self
                      action:@selector(confirmSignOut)
            forControlEvents:UIControlEventTouchUpInside];
        if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
        [view addSubview:button];
        GBTrackModifiedView(view);
      }
      return;
    }
  }
  if (isFabricView && !paired && [primaryLogin containsObject:label] && bounds.size.width >= 160 &&
      bounds.size.height >= 40) {
    if (GBHasAncestorPluginTag(view, 731991))
      return;
    GBRemoveDescendantPluginTag(view, 731991);
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    GBTrackModifiedView(view);
    if ([view viewWithTag:731991]) {
      [self installHostButtonOn:view styled:NO];
    } else {
      BOOL useStyled = !GBSubtreeHasStyledHostButton(view.window, view);
      [self installHostButtonOn:view styled:useStyled];
    }
    return;
  }
  if (isFabricView && !paired && [secondaryLogin containsObject:label] && bounds.size.width >= 160 &&
      bounds.size.height >= 40) {
    if (GBHasAncestorPluginTag(view, 731991))
      return;
    GBRemoveDescendantPluginTag(view, 731991);
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    GBTrackModifiedView(view);
    [self installHostButtonOn:view styled:NO];
    return;
  }
  if (isFabricView && [computerLabels containsObject:label] && bounds.size.width > 300 &&
      bounds.size.height >= 44) {
    if (GBHasAncestorPluginTag(view, 731999))
      return;
    GBRemoveDescendantPluginTag(view, 731999);
    UIButton *existing = (UIButton *)[view viewWithTag:731999];
    if (existing) {
      if (!CGRectEqualToRect(existing.frame, bounds)) existing.frame = bounds;
    } else {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731999;
      button.frame = bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityLabel = GBL(@"Bot 电脑", @"Bot Computer");
      [button addTarget:self
                    action:@selector(showComputers)
          forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
      [view addSubview:button];
      GBTrackModifiedView(view);
    }
    return;
  }
  if (!paired &&
      [debugLabels containsObject:label] && bounds.size.width > 200 &&
      bounds.size.height >= 40) {
    // Unpaired full-width Debug entry opens local Host setup.
    if (GBHasAncestorPluginTag(view, 731991))
      return;
    GBRemoveDescendantPluginTag(view, 731991);
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    GBTrackModifiedView(view);
    [self installHostButtonOn:view styled:NO];
    return;
  }
  if ([GBToolbarHostLabels() containsObject:label] && paired && bounds.size.width <= 88) {
    // Keep the original toolbar and link icon; only route the original touch.
    NSString *hostLabel = GBL(@"连接 Host", @"Host Connection");
    if (![view.accessibilityLabel isEqualToString:hostLabel])
      view.accessibilityLabel = hostLabel;
    if (![view.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"])
      view.accessibilityIdentifier = @"grokbot.host.settings";
    GBTrackModifiedView(view);
    return;
  }
  if (tracked && view.accessibilityIdentifier != nil)
    GBClearHostSettingsIdentifier(view);
  if (isFabricView && [libraryLabels containsObject:label] && paired &&
      bounds.size.width > 20 && bounds.size.height >= 28) {
    if (GBHasAncestorPluginTag(view, 731992))
      return;
    GBRemoveDescendantPluginTag(view, 731992);
    UIButton *existing = (UIButton *)[view viewWithTag:731992];
    if (existing) {
      if (!CGRectEqualToRect(existing.frame, bounds)) existing.frame = bounds;
      NSString *libraryLabel = GBL(@"资料库", @"Library");
      if (![existing.accessibilityLabel isEqualToString:libraryLabel])
        existing.accessibilityLabel = libraryLabel;
    } else {
      // Transparent touch overlay preserving the original row/pill visuals
      // without drawing a second centered title over the native row text.
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731992;
      button.frame = bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityIdentifier = @"grokbot.library.open";
      button.accessibilityLabel = GBL(@"资料库", @"Library");
      [button addTarget:self
                    action:@selector(showLibrary)
          forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
      [view addSubview:button];
      GBTrackModifiedView(view);
    }
    return;
  }
  if (isFabricView && [usageLabels containsObject:label])
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
  GBInvalidateSettingsContextCache();
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
static dispatch_queue_t GBAppIntentsVerifyQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("com.grokbot.local.app-intents-verify", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}
static void GBVerifyAppIntentCredentialsAsync(void) {
  dispatch_async(GBAppIntentsVerifyQueue(), ^{
    GBVerifyAppIntentCredentials();
  });
}
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
  if (GBConnection.shared.isPaired) {
    if (!GBPresenceTimer) {
      GBPresenceTimer = [NSTimer scheduledTimerWithTimeInterval:25 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive &&
            GBConnection.shared.isPaired)
          GBPushSetForeground(YES);
      }];
      GBPresenceTimer.tolerance = 5.0;
    }
  } else if (GBPresenceTimer) {
    [GBPresenceTimer invalidate];
    GBPresenceTimer = nil;
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
typedef NS_ENUM(NSInteger, GBLayoutKind) {
  GBLayoutKindSkip = 0,
  GBLayoutKindEntry = 1,
  GBLayoutKindSwitch = 2,
  GBLayoutKindImage = 3,
};
static GBLayoutKind GBLayoutKindForClass(Class cls) {
  static CFMutableDictionaryRef cache;
  static Class scrollClass, paragraphClass, textInputClass, switchClass, imageClass;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cache = CFDictionaryCreateMutable(NULL, 32, NULL, NULL);
    scrollClass = GBScrollViewClass();
    paragraphClass = NSClassFromString(@"RCTParagraphComponentView");
    textInputClass = NSClassFromString(@"RCTTextInputComponentView");
    switchClass = GBSwitchViewClass();
    imageClass = GBImageViewClass();
  });
  const void *key = (__bridge const void *)cls;
  const void *cached = NULL;
  if (CFDictionaryGetValueIfPresent(cache, key, &cached))
    return (GBLayoutKind)(intptr_t)cached;
  GBLayoutKind kind = GBLayoutKindEntry;
  if ((scrollClass && [cls isSubclassOfClass:scrollClass]) ||
      (paragraphClass && [cls isSubclassOfClass:paragraphClass]) ||
      (textInputClass && [cls isSubclassOfClass:textInputClass]) ||
      [cls isSubclassOfClass:UIScrollView.class]) {
    kind = GBLayoutKindSkip;
  } else if (switchClass && [cls isSubclassOfClass:switchClass]) {
    kind = GBLayoutKindSwitch;
  } else if (imageClass && [cls isSubclassOfClass:imageClass]) {
    kind = GBLayoutKindImage;
  } else if ([NSStringFromClass(cls) hasPrefix:@"RNSVG"]) {
    kind = GBLayoutKindSkip;
  }
  CFDictionarySetValue(cache, key, (const void *)(intptr_t)kind);
  return kind;
}
static void GBLayout(id self, SEL selector) {
  ((void (*)(id, SEL))GBOriginalLayout)(self, selector);
  // Skip known expensive non-target Fabric subclasses (scroll views at 120Hz,
  // text paragraphs, text inputs, RNSVG* avatar nodes) while still handling
  // RCTViewComponentView and custom button/row subclasses on cold screen entry.
  switch (GBLayoutKindForClass([self class])) {
    case GBLayoutKindSkip:
      break;
    case GBLayoutKindEntry:
      [GBInterface replaceEntry:self];
      break;
    case GBLayoutKindSwitch:
      GBReplacePushView(self);
      break;
    case GBLayoutKindImage:
      if (GBConnection.shared.isPaired)
        GBReplaceProfileView(self);
      break;
  }
}
static void GBRecycle(id self, SEL selector) {
  if (GBIsTrackedModifiedView(self)) {
    GBUntrackModifiedView(self);
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
  }
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
  BOOL paired = GBConnection.shared.isPaired;
  Class scrollViewClass = GBScrollViewClass();
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview) {
      if ([v.accessibilityIdentifier isEqualToString:@"grokbot.host.settings"]) {
        [GBConnection.shared show];
        return;
      }
      // Never trigger Fabric's recursive accessibilityLabel on scroll views,
      // windows, or multi-row containers when a scroll swipe begins.
      if ([v isKindOfClass:UIScrollView.class] || [v isKindOfClass:UIWindow.class] ||
          (scrollViewClass && [v isKindOfClass:scrollViewClass]) ||
          v.bounds.size.height > 160.0 || v.subviews.count > 12)
        continue;
      NSString *lbl = v.accessibilityLabel;
      if (lbl.length > 0 && lbl.length <= 40 &&
          ([touchHostLabels containsObject:lbl] || (paired && [lbl isEqualToString:@"link"]))) {
        [GBConnection.shared show];
        return;
      }
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
        GBStopForegroundTimers();
      };
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      [center addObserverForName:UIApplicationDidBecomeActiveNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        GBStartupRefreshed = YES;
                        GBInstall();
                        GBEnsureNetworkReadyAsync();
                        GBVerifyAppIntentCredentialsAsync();
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
      for (NSString *name in @[@"GrokBotProfileChanged", @"GrokBotPushStateChanged", @"RCTContentDidAppearNotification"])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { [GBInterface refresh]; }];
      if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
        GBStartForegroundTimers();
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (restored && GBHost && !GBLoadedPairedBundle) GBReloadReactHost();
        [GBInterface refresh];
        if (!GBStartupRefreshed) {
          GBStartupRefreshed = YES;
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
