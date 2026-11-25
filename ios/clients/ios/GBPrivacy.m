#import "GBPrivacy.h"
#import "GBDiagnostics.h"

// The JS patch prevents SDK initialization. This transport filter also prevents
// a native SDK from flushing a queue saved by an earlier installed build.
@interface GBPrivacyProtocol : NSURLProtocol
@end
@implementation GBPrivacyProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  static NSSet<NSString *> *exactDomains;
  static NSArray<NSString *> *suffixDomains;
  static NSSet<NSString *> *blockedPaths;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSArray<NSString *> *domains = @[
      @"sentry.io", @"braze.com", @"appboy.com", @"appsflyer.com",
      @"appsflyersdk.com", @"statsig.com", @"statsigcdn.com", @"statsigapi.net"
    ];
    exactDomains = [NSSet setWithArray:domains];
    NSMutableArray<NSString *> *suffixes = [NSMutableArray arrayWithCapacity:domains.count];
    for (NSString *domain in domains)
      [suffixes addObject:[@"." stringByAppendingString:domain]];
    suffixDomains = [suffixes copy];
    blockedPaths = [NSSet setWithArray:@[
      @"/aiserver.v1.AnalyticsService/TrackEvents",
      @"/aiserver.v1.AnalyticsService/SubmitLogs"
    ]];
  });
  NSString *rawHost = request.URL.host;
  if (rawHost.length) {
    NSString *host = rawHost.lowercaseString;
    if ([exactDomains containsObject:host]) return YES;
    for (NSString *suffix in suffixDomains) {
      if ([host hasSuffix:suffix]) return YES;
    }
  }
  NSString *path = request.URL.path;
  return path.length && [blockedPaths containsObject:path];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  GBDiagnosticsEvent(@"telemetry.blocked", @{@"host":self.request.URL.host ?: @"", @"path":self.request.URL.path ?: @""});
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:204 HTTPVersion:@"HTTP/1.1" headerFields:@{}];
  [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end
Class GBPrivacyProtocolClass(void) { return GBPrivacyProtocol.class; }
