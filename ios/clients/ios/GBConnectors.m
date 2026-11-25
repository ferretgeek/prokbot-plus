#import "GBConnectors.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBPrivacy.h"
#import "GBSpeech.h"
#import "GBVoice.h"
#import "GBAppIntents.h"
#import "GBSharing.h"
#import "GBDiagnostics.h"
#import <objc/runtime.h>

static NSSet *GBConnectorMethods(void) {
  static NSSet *methods; static dispatch_once_t once;
  dispatch_once(&once, ^{ methods = [NSSet setWithArray:@[
    @"ListMarketplacePlugins", @"ListPrivateMarketplacePlugins", @"ListMarketplaces", @"GetEffectiveUserPlugins",
    @"GetAvailableMcpServers", @"ListSandMcpTools", @"ValidateMcpOAuthTokens",
    @"InstallUserPlugin", @"UninstallUserPlugin", @"UpdateUserPlugin", @"UpdateUserPluginVariables",
    @"RenameMcpOAuthAccount", @"DeleteMcpOAuthAccount", @"CheckHttpMcpStatus",
    @"CompleteMcpOAuth", @"GetPluginDetails", @"GetGrokBotMcpToolPermissions",
    @"SetGrokBotMcpToolPermissions",
    @"ListUserCanvases", @"GetCanvasMetadata", @"GetCanvasPayload",
    @"SetCanvasVisibility", @"SetPageAddress", @"GetCanvasShareAccess",
    @"UpdateCanvasShareAccess", @"RefreshCanvasSources"
  ]]; }); return methods;
}
static NSString *GBConnectorMethod(NSURLRequest *request) {
  NSString *path = request.URL.path;
  NSRange service = [path rangeOfString:@"/aiserver.v1.DashboardService/"];
  if (service.location == NSNotFound || ![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *method = [path substringFromIndex:NSMaxRange(service)];
  return [GBConnectorMethods() containsObject:method] ? method : nil;
}
// Self-hosted Hosts do not have Cursor enterprise team policies or cloud
// Background Composer preferences. In iOS 1.26+, Auto-review checks both RPCs
// via PrReviewPreferencesService to see whether a team admin enforces it;
// failing them locks the toggle with "Couldn't check your team's settings."
// Mirror Desktop's empty local response (`{}`) when paired to a local Host.
static NSData *GBLocalPreferenceResponse(NSURLRequest *request) {
  if (![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *path = request.URL.path;
  if ([path isEqual:@"/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam"] ||
      [path isEqual:@"/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings"]) {
    static NSData *emptyJson;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ emptyJson = [@"{}" dataUsingEncoding:NSUTF8StringEncoding]; });
    return emptyJson;
  }
  return nil;
}
@interface GBConnectorProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(atomic,assign) BOOL cancelled;
@end
@implementation GBConnectorProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return GBConnection.shared.deviceToken.length &&
    (GBConnectorMethod(request) != nil || GBLocalPreferenceResponse(request) != nil);
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  NSData *localBody = GBLocalPreferenceResponse(self.request);
  if (localBody) {
    GBDiagnosticsEvent(@"local-rpc.handled", @{@"path": self.request.URL.path ?: @""});
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL
      statusCode:200 HTTPVersion:@"HTTP/1.1"
      headerFields:@{@"Content-Type": @"application/json",
                     @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)localBody.length]}];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [self.client URLProtocol:self didLoadData:localBody];
    [self.client URLProtocolDidFinishLoading:self];
    return;
  }
  NSString *serverURL = GBConnection.shared.serverURL;
  NSString *deviceToken = GBConnection.shared.deviceToken;
  NSString *method = GBConnectorMethod(self.request);
  if (!serverURL.length || !deviceToken.length || !method.length) {
    [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"GrokBotConnectors" code:401 userInfo:nil]];
    return;
  }
  NSString *path = [@"/local/mobile-rpc/" stringByAppendingString:method];
  NSURL *targetURL = [NSURL URLWithString:[serverURL stringByAppendingString:path]];
  if (!targetURL) {
    [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"GrokBotConnectors" code:400 userInfo:nil]];
    return;
  }
  NSMutableURLRequest *request = [self.request mutableCopy];
  request.URL = targetURL;
  request.allHTTPHeaderFields = @{ @"Content-Type": @"application/json", @"Accept": @"application/json",
    @"Authorization": [@"Bearer " stringByAppendingString:deviceToken] };
  request.timeoutInterval = 30;
  self.task = [GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]];
      return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    NSHTTPURLResponse *originalURLResponse = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:http.statusCode HTTPVersion:@"HTTP/1.1" headerFields:http.allHeaderFields];
    [self.client URLProtocol:self didReceiveResponse:originalURLResponse cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
static IMP GBDefaultConfig, GBEphemeralConfig, GBSessionWithConfig, GBSessionWithConfigDelegate;
static NSURLSessionConfiguration *GBAddProtocol(NSURLSessionConfiguration *config) {
  if (!config || config.identifier.length > 0) return config;
  NSMutableArray *classes = [config.protocolClasses mutableCopy] ?: [NSMutableArray new];
  if (![classes containsObject:GBConnectorProtocol.class]) [classes insertObject:GBConnectorProtocol.class atIndex:0];
  if (![classes containsObject:GBPrivacyProtocolClass()]) [classes insertObject:GBPrivacyProtocolClass() atIndex:0];
  if (![classes containsObject:GBSpeechProtocolClass()]) [classes insertObject:GBSpeechProtocolClass() atIndex:0];
  if (![classes containsObject:GBVoiceProtocolClass()]) [classes insertObject:GBVoiceProtocolClass() atIndex:0];
  if (![classes containsObject:GBAppIntentsProtocolClass()]) [classes insertObject:GBAppIntentsProtocolClass() atIndex:0];
  if (![classes containsObject:GBSharingProtocolClass()]) [classes insertObject:GBSharingProtocolClass() atIndex:0];
  config.protocolClasses = classes; return config;
}
static id GBDefault(id self, SEL selector) { return GBAddProtocol(((id(*)(id,SEL))GBDefaultConfig)(self,selector)); }
static id GBEphemeral(id self, SEL selector) { return GBAddProtocol(((id(*)(id,SEL))GBEphemeralConfig)(self,selector)); }
// Swizzle NSURLSession factory methods instead of replacing RN's process-wide
// RCTSetCustomNSURLSessionConfigurationProvider, so any custom configuration
// provider installed by the app keeps its headers, caching, and protocols while
// our local NSURLProtocols stay prepended on a copy of the configuration.
// Background session configurations (non-empty identifier) run out-of-process and
// do not support custom NSURLProtocol subclasses, so pass them through untouched.
static id GBSession(id self, SEL selector, NSURLSessionConfiguration *config) {
  NSURLSessionConfiguration *patched = (config && config.identifier.length == 0) ? GBAddProtocol([config copy]) : config;
  return ((id(*)(id,SEL,id))GBSessionWithConfig)(self, selector, patched);
}
static id GBSessionDelegate(id self, SEL selector, NSURLSessionConfiguration *config, id delegate, NSOperationQueue *queue) {
  NSURLSessionConfiguration *patched = (config && config.identifier.length == 0) ? GBAddProtocol([config copy]) : config;
  return ((id(*)(id,SEL,id,id,id))GBSessionWithConfigDelegate)(self, selector, patched, delegate, queue);
}
void GBInstallConnectorTransport(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [NSURLProtocol registerClass:GBConnectorProtocol.class];
    [NSURLProtocol registerClass:GBPrivacyProtocolClass()];
    [NSURLProtocol registerClass:GBSpeechProtocolClass()];
    [NSURLProtocol registerClass:GBVoiceProtocolClass()];
    [NSURLProtocol registerClass:GBAppIntentsProtocolClass()];
    [NSURLProtocol registerClass:GBSharingProtocolClass()];
    Method a=class_getClassMethod(NSURLSessionConfiguration.class,@selector(defaultSessionConfiguration));
    Method b=class_getClassMethod(NSURLSessionConfiguration.class,@selector(ephemeralSessionConfiguration));
    Method c=class_getClassMethod(NSURLSession.class,@selector(sessionWithConfiguration:));
    Method d=class_getClassMethod(NSURLSession.class,@selector(sessionWithConfiguration:delegate:delegateQueue:));
    GBDefaultConfig=method_setImplementation(a,(IMP)GBDefault);
    GBEphemeralConfig=method_setImplementation(b,(IMP)GBEphemeral);
    if (c) GBSessionWithConfig=method_setImplementation(c,(IMP)GBSession);
    if (d) GBSessionWithConfigDelegate=method_setImplementation(d,(IMP)GBSessionDelegate);
  });
}
