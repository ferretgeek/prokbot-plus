#import <UIKit/UIKit.h>
#import "GBLocalize.h"
static NSString *const GBLocaleKey = @"GrokBotLocal.interfaceLanguage";
static NSString *GBCachedLanguage;
static BOOL GBLanguageLoaded;
static BOOL GBCachedIsChinese;
static BOOL GBComputeIsChinese(NSString *language) {
  if (!language.length) language = NSLocale.preferredLanguages.firstObject;
  return [language.lowercaseString hasPrefix:@"zh"];
}
static void GBEnsureLanguageLoadedLocked(void) {
  if (GBLanguageLoaded) return;
  GBCachedLanguage = [NSUserDefaults.standardUserDefaults stringForKey:GBLocaleKey];
  GBCachedIsChinese = GBComputeIsChinese(GBCachedLanguage);
  GBLanguageLoaded = YES;
}
BOOL GBIsChinese(void) {
  @synchronized (GBLocaleKey) {
    GBEnsureLanguageLoadedLocked();
    return GBCachedIsChinese;
  }
}
NSString *GBL(NSString *chinese, NSString *english) { return GBIsChinese() ? chinese : english; }
void GBObserveAppLanguage(NSString *label) {
  if (!label.length || label.length > 32) return;
  static NSSet<NSString *> *zhLabels;
  static NSSet<NSString *> *enLabels;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    zhLabels = [NSSet setWithArray:@[
      @"账户", @"调试", @"用量", @"语言", @"连接服务端", @"退出登录", @"登出",
      @"通过 Apple 登录", @"透過 Apple 登入", @"用邮箱继续"
    ]];
    enLabels = [NSSet setWithArray:@[
      @"Account", @"Debug", @"Usage", @"Language", @"Connect to Host",
      @"Sign out", @"Sign in with Apple", @"Continue with email"
    ]];
  });
  // These labels are emitted by the original Lingui settings/account controls.
  // Observe their resolved language, so an in-app override wins over iOS locale.
  NSString *language = nil;
  if ([zhLabels containsObject:label]) language = @"zh";
  else if ([enLabels containsObject:label]) language = @"en";
  if (!language) return;
  BOOL changed = NO;
  @synchronized (GBLocaleKey) {
    GBEnsureLanguageLoadedLocked();
    if (![language isEqualToString:GBCachedLanguage]) {
      GBCachedLanguage = language;
      GBCachedIsChinese = [language isEqualToString:@"zh"];
      changed = YES;
    }
  }
  if (changed) [NSUserDefaults.standardUserDefaults setObject:language forKey:GBLocaleKey];
}
UIViewController *GBTopController(void) {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow) top = window.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}
void GBPresentController(UIViewController *controller) {
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:controller];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  if (@available(iOS 15.0, *)) {
    nav.sheetPresentationController.detents = @[UISheetPresentationControllerDetent.largeDetent];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
  }
  [GBTopController() presentViewController:nav animated:YES completion:nil];
}
