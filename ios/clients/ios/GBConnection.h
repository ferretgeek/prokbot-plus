#import <UIKit/UIKit.h>
@interface GBConnection : NSObject
+ (instancetype)shared;
@property(nonatomic, readonly) NSString *serverURL;
@property(nonatomic, readonly) NSString *deviceToken;
@property(nonatomic, readonly, getter=isPaired) BOOL paired;
@property(nonatomic, readonly) NSURL *gatewayBundleURL;
@property(nonatomic, strong) NSURL *resourcesURL;
@property(nonatomic, copy) void (^didConnect)(void);
@property(nonatomic, copy) void (^didDisconnect)(void);
- (BOOL)restore:(NSError **)error;
- (void)show;
- (void)disconnect;
@end
@class UIView;
FOUNDATION_EXPORT void GBReloadReactHost(void);
FOUNDATION_EXPORT void GBOpenAgent(NSString *agentId);
FOUNDATION_EXPORT void GBTrackModifiedView(UIView *view);
FOUNDATION_EXPORT BOOL GBHasAncestorPluginTag(UIView *view, NSInteger tag);
FOUNDATION_EXPORT void GBRemoveDescendantPluginTag(UIView *view, NSInteger tag);
FOUNDATION_EXPORT BOOL GBIsGlobalSettingsContext(UIView *view);
