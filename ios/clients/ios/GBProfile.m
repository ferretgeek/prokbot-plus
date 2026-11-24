#import "GBLocalize.h"
#import "GBProfile.h"
#import "GBConnection.h"
#import "GBNetwork.h"
#import "GBHTTP.h"
#import <PhotosUI/PhotosUI.h>
#import <objc/runtime.h>
#import <CommonCrypto/CommonDigest.h>
static NSDictionary *GBUserProfile;
static UIImage *GBUserAvatar;
static NSString *GBProfileScope;
static char GBOriginalVisibility;
static char GBHiddenSiblingsKey;
static dispatch_queue_t GBProfileIOQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("dev.grokbot.profile.io", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}
static Class GBParagraphViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTParagraphComponentView"); });
  return cls;
}
static NSString *GBCurrentProfileScope(void) {
  NSString *scope = [NSString stringWithFormat:@"%@\n%@", (GBNetworkAddress().length ? GBNetworkAddress() : GBConnection.shared.serverURL) ?: @"",
    [NSUserDefaults.standardUserDefaults stringForKey:@"GrokBotLocal.deviceId"] ?: @""];
  NSData *bytes = [scope dataUsingEncoding:NSUTF8StringEncoding]; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [result appendFormat:@"%02x", digest[index]];
  return result;
}
static NSURL *GBProfileCacheURL(void) {
  NSURL *directory = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
  return [directory URLByAppendingPathComponent:@"GrokBotLocal-profile.plist"];
}
void GBResetProfileView(UIView *view) {
  for (UIView *child in view.subviews) {
    NSNumber *hidden = objc_getAssociatedObject(child, &GBOriginalVisibility);
    if (hidden) {
      BOOL original = hidden.boolValue;
      if (child.hidden != original) child.hidden = original;
      objc_setAssociatedObject(child, &GBOriginalVisibility, nil,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
  }
  NSHashTable<UIView *> *siblings = objc_getAssociatedObject(view, &GBHiddenSiblingsKey);
  if (siblings) {
    for (UIView *sibling in siblings) {
      NSNumber *hidden = objc_getAssociatedObject(sibling, &GBOriginalVisibility);
      if (hidden) {
        BOOL original = hidden.boolValue;
        if (sibling.hidden != original) sibling.hidden = original;
        objc_setAssociatedObject(sibling, &GBOriginalVisibility, nil,
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
    }
    objc_setAssociatedObject(view, &GBHiddenSiblingsKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}
NSString *GBProfileName(void) {
  NSString *value = GBUserProfile[@"displayName"];
  return [value isKindOfClass:NSString.class] && value.length ? value : GBL(@"本地用户", @"Local user");
}
NSString *GBProfileHostName(void) {
  NSString *value = GBUserProfile[@"hostName"];
  return [value isKindOfClass:NSString.class] && value.length ? value : @"Grok Bot Host";
}
UIImage *GBProfileAvatar(void) { return GBUserAvatar; }
static void GBSetProfile(NSDictionary *value) {
  GBUserProfile = value;
  GBUserAvatar = nil;
  NSString *encoded = value[@"avatarDataUrl"];
  if ([encoded isKindOfClass:NSString.class]) {
    NSRange comma = [encoded rangeOfString:@","];
    if (comma.location != NSNotFound)
      GBUserAvatar = [UIImage
          imageWithData:[[NSData alloc]
                            initWithBase64EncodedString:[encoded
                                                            substringFromIndex:comma.location + 1]
                                                options:0]];
  }
}
void GBRestoreProfileCache(void) {
  NSString *scope = GBCurrentProfileScope();
  if ([GBProfileScope isEqual:scope]) return;
  GBProfileScope = scope;
  GBSetProfile(@{});
  NSData *data = [NSData dataWithContentsOfURL:GBProfileCacheURL()];
  NSDictionary *cache = data ? [NSPropertyListSerialization propertyListWithData:data options:0 format:nil error:nil] : nil;
  NSDictionary *profile = [cache isKindOfClass:NSDictionary.class] ? cache[@"profile"] : nil;
  if ([cache[@"scope"] isEqual:scope] && [profile isKindOfClass:NSDictionary.class] &&
      [profile[@"displayName"] isKindOfClass:NSString.class] && [profile[@"displayName"] length])
    GBSetProfile(profile);
}
void GBClearProfileCache(void) {
  GBProfileScope = nil;
  GBSetProfile(@{});
  NSURL *url = GBProfileCacheURL();
  if (!url) return;
  dispatch_sync(GBProfileIOQueue(), ^{
    [NSFileManager.defaultManager removeItemAtURL:url error:nil];
  });
}
static void GBSaveProfileCache(void) {
  NSMutableDictionary *profile = [GBUserProfile mutableCopy];
  if (!profile) return;
  if (profile[@"avatarDataUrl"] == NSNull.null) [profile removeObjectForKey:@"avatarDataUrl"];
  if (profile[@"updatedAt"] == NSNull.null) [profile removeObjectForKey:@"updatedAt"];
  NSString *scope = [GBProfileScope ?: GBCurrentProfileScope() copy];
  NSDictionary *cache = @{@"scope":scope, @"profile":[profile copy]};
  NSURL *url = GBProfileCacheURL();
  if (!url) return;
  dispatch_async(GBProfileIOQueue(), ^{
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:cache format:NSPropertyListBinaryFormat_v1_0 options:0 error:nil];
    if (!data) return;
    [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    [data writeToURL:url options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:url.path error:nil];
  });
}
static void GBProfileRequest(NSString *method, NSDictionary *body,
                             void (^complete)(NSDictionary *, NSError *)) {
  NSString *serverURL = GBConnection.shared.serverURL;
  NSString *deviceToken = GBConnection.shared.deviceToken;
  if (!serverURL.length || !deviceToken.length)
    return;
  GBRestoreProfileCache();
  NSURL *url = [NSURL URLWithString:[serverURL stringByAppendingString:@"/local/profile"]];
  if (!url)
    return;
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url];
  r.HTTPMethod = method;
  r.timeoutInterval = 20;
  [r setValue:[@"Bearer " stringByAppendingString:deviceToken]
      forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[GBHTTPSession()
      dataTaskWithRequest:r
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          NSDictionary *value =
              data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
              ? ((NSHTTPURLResponse *)response).statusCode : 0;
          dispatch_async(dispatch_get_main_queue(), ^{
            if (![serverURL isEqual:GBConnection.shared.serverURL] ||
                ![deviceToken isEqual:GBConnection.shared.deviceToken]) return;
            if (error || status != 200 ||
                ![value isKindOfClass:NSDictionary.class] ||
                ![value[@"displayName"] isKindOfClass:NSString.class] ||
                ![value[@"displayName"] length]) {
              if (complete)
                complete(nil,
                         error ?: [NSError errorWithDomain:@"GrokBotProfile" code:1 userInfo:nil]);
              return;
            }
            if ([value isEqualToDictionary:GBUserProfile]) {
              if (complete)
                complete(value, nil);
              return;
            }
            GBSetProfile(value);
            GBSaveProfileCache();
            [NSNotificationCenter.defaultCenter postNotificationName:@"GrokBotProfileChanged"
                                                              object:nil];
            if (complete)
              complete(value, nil);
          });
        }] resume];
}
void GBRefreshProfile(void) { GBProfileRequest(@"GET", nil, nil); }
@interface GBProfileController : UIViewController <PHPickerViewControllerDelegate>
@property(nonatomic, strong) UITextField *name;
@property(nonatomic, strong) UIButton *avatar;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, copy) NSString *avatarData;
@end
@implementation GBProfileController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = GBL(@"个人资料", @"Profile");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:GBL(@"保存", @"Save")
                                       style:UIBarButtonItemStyleDone
                                      target:self
                                      action:@selector(save)];
  self.avatar = [UIButton buttonWithType:UIButtonTypeCustom];
  self.avatar.layer.cornerRadius = 44;
  self.avatar.clipsToBounds = YES;
  self.avatar.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  [self.avatar.heightAnchor constraintEqualToConstant:88].active = YES;
  [self.avatar.widthAnchor constraintEqualToConstant:88].active = YES;
  [self.avatar addTarget:self action:@selector(pick) forControlEvents:UIControlEventTouchUpInside];
  UIView *avatarHolder = [UIView new];
  [avatarHolder.heightAnchor constraintEqualToConstant:104].active = YES;
  self.avatar.translatesAutoresizingMaskIntoConstraints = NO;
  [avatarHolder addSubview:self.avatar];
  [NSLayoutConstraint activateConstraints:@[
    [self.avatar.centerXAnchor constraintEqualToAnchor:avatarHolder.centerXAnchor],
    [self.avatar.topAnchor constraintEqualToAnchor:avatarHolder.topAnchor]
  ]];
  self.name = [UITextField new];
  self.name.text = GBProfileName();
  self.name.placeholder = GBL(@"用户名", @"Name");
  self.name.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  self.name.layer.cornerRadius = 16;
  self.name.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  self.name.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 16, 1)];
  self.name.leftViewMode = UITextFieldViewModeAlways;
  [self.name.heightAnchor constraintEqualToConstant:52].active = YES;
  self.status = [UILabel new];
  self.status.text = @"";
  self.status.textColor = UIColor.secondaryLabelColor;
  self.status.numberOfLines = 0;
  self.status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
  UIButton *remove = [UIButton buttonWithType:UIButtonTypeSystem];
  [remove setTitle:GBL(@"移除头像", @"Remove photo") forState:UIControlStateNormal];
  [remove setTitleColor:UIColor.secondaryLabelColor forState:UIControlStateNormal];
  [remove addTarget:self
                action:@selector(clearAvatar)
      forControlEvents:UIControlEventTouchUpInside];
  UIStackView *stack = [[UIStackView alloc]
      initWithArrangedSubviews:@[ avatarHolder, self.name, remove, self.status ]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 18;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-24],
    [stack.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:24]
  ]];
  self.avatarData = [GBUserProfile[@"avatarDataUrl"] isKindOfClass:NSString.class]
                        ? GBUserProfile[@"avatarDataUrl"]
                        : nil;
  [self paint:GBProfileAvatar()];
  GBProfileRequest(@"GET", nil, ^(NSDictionary *value, NSError *error) {
    if (!error) {
      self.name.text = GBProfileName();
      self.avatarData =
          [value[@"avatarDataUrl"] isKindOfClass:NSString.class] ? value[@"avatarDataUrl"] : nil;
      [self paint:GBProfileAvatar()];
    }
  });
}
- (void)paint:(UIImage *)image {
  [self.avatar setImage:image forState:UIControlStateNormal];
  [self.avatar setTitle:image ? @"" : GBL(@"选择头像", @"Choose photo") forState:UIControlStateNormal];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)clearAvatar {
  self.avatarData = nil;
  [self paint:nil];
}
- (void)pick {
  PHPickerConfiguration *c = [PHPickerConfiguration new];
  c.selectionLimit = 1;
  c.filter = PHPickerFilter.imagesFilter;
  PHPickerViewController *p = [[PHPickerViewController alloc] initWithConfiguration:c];
  p.delegate = self;
  [self presentViewController:p animated:YES completion:nil];
}
- (void)picker:(PHPickerViewController *)picker
    didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  NSItemProvider *provider = results.firstObject.itemProvider;
  if (![provider canLoadObjectOfClass:UIImage.class])
    return;
  __weak typeof(self) weakSelf = self;
  [provider loadObjectOfClass:UIImage.class
            completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
              if (error || ![object isKindOfClass:UIImage.class])
                return;
              UIImage *source = (UIImage *)object;
              if (source.size.width <= 0 || source.size.height <= 0)
                return;
              UIGraphicsImageRenderer *r =
                  [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(256, 256)];
              UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *c) {
                CGFloat scale = MAX(256.0 / source.size.width, 256.0 / source.size.height);
                CGSize size = CGSizeMake(source.size.width * scale, source.size.height * scale);
                [source drawInRect:CGRectMake((256.0 - size.width) / 2.0,
                                              (256.0 - size.height) / 2.0,
                                              size.width, size.height)];
              }];
              NSData *png = UIImagePNGRepresentation(image);
              if (!png.length)
                return;
              NSString *encoded = [@"data:image/png;base64,"
                  stringByAppendingString:[png base64EncodedStringWithOptions:0]];
              dispatch_async(dispatch_get_main_queue(), ^{
                typeof(self) strongSelf = weakSelf;
                if (!strongSelf)
                  return;
                strongSelf.avatarData = encoded;
                [strongSelf paint:image];
              });
            }];
}
- (void)save {
  NSString *name = [self.name.text
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!name.length || name.length > 80) {
    self.status.text = GBL(@"请输入 1–80 个字符的用户名。", @"Enter a name with 1–80 characters.");
    return;
  }
  self.navigationItem.rightBarButtonItem.enabled = NO;
  self.status.text = GBL(@"正在保存…", @"Saving…");
  GBProfileRequest(@"PUT",
                   @{@"displayName" : name, @"avatarDataUrl" : self.avatarData ?: NSNull.null},
                   ^(NSDictionary *value, NSError *error) {
                     self.navigationItem.rightBarButtonItem.enabled = YES;
                     if (error) {
                       self.status.text = GBL(@"保存失败，请重试。", @"Could not save. Try again.");
                       return;
                     }
                     [self close];
                   });
}
@end
void GBShowProfile(void) {
  UIViewController *top = nil;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow)
          top = w.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  [top presentViewController:[[UINavigationController alloc]
                                 initWithRootViewController:[GBProfileController new]]
                    animated:YES
                  completion:nil];
}

// The pinned Hermes adapter has a local synthetic user; replace only its two
// exact native surfaces so Bot identities and other original controls remain native.
@interface GBProfileEntry : NSObject
+ (void)open;
@end
@implementation GBProfileEntry
+ (void)open {
  GBShowProfile();
}
@end
BOOL GBReplaceProfileView(UIView *view) {
  if (!GBConnection.shared.deviceToken.length)
    return NO;
  NSString *label = view.accessibilityLabel;
  if (![label hasPrefix:@"dev-gateway@localhost"])
    return NO;
  UIView *cover = [view viewWithTag:731993];
  if (cover && cover.accessibilityLabel.length) {
    NSString *suffix = [@", " stringByAppendingString:cover.accessibilityLabel];
    if (label.length > suffix.length && [label hasSuffix:suffix])
      label = [label substringToIndex:label.length - suffix.length];
  }
  BOOL avatar = [label isEqualToString:@"dev-gateway@localhost avatar"];
  BOOL row = [label isEqualToString:@"dev-gateway@localhost"] && view.bounds.size.width > 300 &&
             view.bounds.size.height > 50;
  if (!avatar && !row)
    return NO;
  if (!cover) {
    cover = row ? [UIButton buttonWithType:UIButtonTypeCustom] : [UIView new];
    cover.tag = 731993;
    cover.frame = view.bounds;
    cover.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    cover.backgroundColor = [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
      return t.userInterfaceStyle == UIUserInterfaceStyleDark ? [UIColor colorWithWhite:.17 alpha:1]
                                                              : UIColor.whiteColor;
    }];
    if (row) {
      [(UIButton *)cover addTarget:GBProfileEntry.class
                            action:@selector(open)
                  forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled)
        view.userInteractionEnabled = YES;
    } else {
      cover.userInteractionEnabled = NO;
      cover.layer.cornerRadius = view.bounds.size.width / 2;
      cover.clipsToBounds = YES;
    }
    UIImageView *image = [UIImageView new];
    image.tag = 731994;
    image.contentMode = UIViewContentModeScaleAspectFill;
    image.clipsToBounds = YES;
    image.backgroundColor = UIColor.tertiarySystemGroupedBackgroundColor;
    [cover addSubview:image];
    UILabel *initial = [UILabel new];
    initial.tag = 731995;
    initial.textAlignment = NSTextAlignmentCenter;
    initial.font = [UIFont systemFontOfSize:17 weight:UIFontWeightMedium];
    initial.textColor = UIColor.secondaryLabelColor;
    [cover addSubview:initial];
    if (row) {
      UILabel *name = [UILabel new];
      name.tag = 731996;
      name.font = [UIFont systemFontOfSize:17];
      name.textColor = UIColor.labelColor;
      [cover addSubview:name];
      UILabel *subtitle = [UILabel new];
      subtitle.tag = 731997;
      subtitle.font = [UIFont systemFontOfSize:14];
      subtitle.textColor = UIColor.secondaryLabelColor;
      [cover addSubview:subtitle];
      UIImageView *chevron =
          [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"chevron.right"]];
      chevron.tag = 731998;
      chevron.tintColor = UIColor.tertiaryLabelColor;
      [cover addSubview:chevron];
    }
    [view addSubview:cover];
  } else {
    if (!CGRectEqualToRect(cover.frame, view.bounds))
      cover.frame = view.bounds;
    if (avatar) {
      CGFloat coverRadius = view.bounds.size.width / 2;
      if (cover.layer.cornerRadius != coverRadius)
        cover.layer.cornerRadius = coverRadius;
    }
  }
  if (cover.layer.zPosition != 1000)
    cover.layer.zPosition = 1000;
  if (view.subviews.lastObject != cover)
    [view bringSubviewToFront:cover];
  if (avatar) {
    for (UIView *child in view.subviews) {
      if (child == cover)
        continue;
      if (!objc_getAssociatedObject(child, &GBOriginalVisibility))
        objc_setAssociatedObject(child, &GBOriginalVisibility, @(child.hidden),
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (!child.hidden)
        child.hidden = YES;
    }
    // Fabric renders the original letter as an absolute-positioned sibling of
    // its image. Hide only that text inside the avatar rectangle, not row text.
    UIView *container = view.superview;
    Class paragraphClass = GBParagraphViewClass();
    if (container && paragraphClass) {
      CGRect avatarRect = [view convertRect:view.bounds toView:container];
      NSHashTable<UIView *> *hiddenSiblings = objc_getAssociatedObject(view, &GBHiddenSiblingsKey);
      for (UIView *sibling in container.subviews) {
        if (sibling == view || ![sibling isKindOfClass:paragraphClass])
          continue;
        CGRect textRect = [sibling convertRect:sibling.bounds toView:container];
        if (!CGRectContainsRect(avatarRect, textRect)) continue;
        if (!objc_getAssociatedObject(sibling, &GBOriginalVisibility))
          objc_setAssociatedObject(sibling, &GBOriginalVisibility, @(sibling.hidden),
                                   OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        if (!hiddenSiblings) {
          hiddenSiblings = NSHashTable.weakObjectsHashTable;
          objc_setAssociatedObject(view, &GBHiddenSiblingsKey, hiddenSiblings,
                                   OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        [hiddenSiblings addObject:sibling];
        if (!sibling.hidden)
          sibling.hidden = YES;
      }
    }
  }
  CGRect imageFrame = row ? CGRectMake(18, 15, 40, 40) : cover.bounds;
  UIImageView *image = (UIImageView *)[cover viewWithTag:731994];
  if (!CGRectEqualToRect(image.frame, imageFrame))
    image.frame = imageFrame;
  CGFloat imageRadius = imageFrame.size.width / 2;
  if (image.layer.cornerRadius != imageRadius)
    image.layer.cornerRadius = imageRadius;
  UIImage *avatarImage = GBProfileAvatar();
  if (image.image != avatarImage)
    image.image = avatarImage;
  NSString *displayName = GBProfileName();
  NSString *initialText = displayName.length
      ? [displayName substringWithRange:[displayName rangeOfComposedCharacterSequenceAtIndex:0]]
      : @"";
  UILabel *initial = (UILabel *)[cover viewWithTag:731995];
  if (!CGRectEqualToRect(initial.frame, imageFrame))
    initial.frame = imageFrame;
  BOOL hideInitial = (avatarImage != nil);
  if (initial.hidden != hideInitial)
    initial.hidden = hideInitial;
  if (![initial.text isEqualToString:initialText])
    initial.text = initialText;
  if (row) {
    UILabel *name = (UILabel *)[cover viewWithTag:731996];
    CGRect nameFrame = CGRectMake(68, 14, cover.bounds.size.width - 112, 22);
    if (!CGRectEqualToRect(name.frame, nameFrame))
      name.frame = nameFrame;
    if (![name.text isEqualToString:displayName])
      name.text = displayName;
    UILabel *subtitle = (UILabel *)[cover viewWithTag:731997];
    CGRect subtitleFrame = CGRectMake(68, 38, cover.bounds.size.width - 112, 18);
    if (!CGRectEqualToRect(subtitle.frame, subtitleFrame))
      subtitle.frame = subtitleFrame;
    NSString *hostName = GBProfileHostName();
    if (![subtitle.text isEqualToString:hostName])
      subtitle.text = hostName;
    UIView *chevron = [cover viewWithTag:731998];
    CGRect chevronFrame = CGRectMake(cover.bounds.size.width - 34, 27, 10, 16);
    if (!CGRectEqualToRect(chevron.frame, chevronFrame))
      chevron.frame = chevronFrame;
    NSString *coverLabel = [NSString stringWithFormat:GBL(@"个人资料，%@", @"Profile, %@"), displayName];
    if (![cover.accessibilityLabel isEqualToString:coverLabel])
      cover.accessibilityLabel = coverLabel;
  }
  return YES;
}
