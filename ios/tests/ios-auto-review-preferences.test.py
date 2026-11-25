#!/usr/bin/env python3
"""Regression checks for iOS 1.26+ Auto-review team/user preference RPC interception."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

OBJC_HARNESS = r"""
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>

#import "GBConnectors.m"
#import "GBVoice.m"

static int mockVoiceHostStatusCode = 200;
static NSString *mockVoiceHostBody = @"{\"enabled\":true}";
static NSString *lastForwardedAuth = nil;
static NSString *lastForwardedURL = nil;

@interface GBMockHostHTTPProtocol : NSURLProtocol
@end
@implementation GBMockHostHTTPProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.URL.host isEqual:@"127.0.0.1"];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  lastForwardedURL = self.request.URL.absoluteString;
  lastForwardedAuth = [self.request valueForHTTPHeaderField:@"Authorization"];
  NSHTTPURLResponse *resp = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL
    statusCode:mockVoiceHostStatusCode HTTPVersion:@"HTTP/1.1"
    headerFields:@{@"Content-Type":@"application/json"}];
  [self.client URLProtocol:self didReceiveResponse:resp cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  NSData *data = [mockVoiceHostBody dataUsingEncoding:NSUTF8StringEncoding];
  if (data.length) [self.client URLProtocol:self didLoadData:data];
  [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end

BOOL GBVoiceAudioAvailable(void) { return YES; }
void GBVoiceAudioObserveSocket(id socket) {}
BOOL GBVoiceCredentialIsValid(id credential, NSString *serverURL) { return YES; }
NSString *GBL(NSString *zh, NSString *en) { return en; }

@interface GBConnection ()
@property(nonatomic, readwrite) NSString *serverURL;
@property(nonatomic, readwrite) NSString *deviceToken;
@end

@implementation GBConnection
+ (instancetype)shared {
  static GBConnection *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ instance = [self new]; });
  return instance;
}
- (BOOL)restore:(NSError **)error { return NO; }
- (void)show {}
- (void)disconnect {}
@end

static int httpSessionCalls = 0;
static NSMutableArray<NSString *> *handledPaths = nil;

NSURLSession *GBHTTPSession(void) {
  httpSessionCalls++;
  NSURLSessionConfiguration *cfg = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  cfg.protocolClasses = @[GBMockHostHTTPProtocol.class];
  return [NSURLSession sessionWithConfiguration:cfg];
}
Class GBPrivacyProtocolClass(void) { return NSURLProtocol.class; }
Class GBSpeechProtocolClass(void) { return NSURLProtocol.class; }
Class GBAppIntentsProtocolClass(void) { return NSURLProtocol.class; }
Class GBSharingProtocolClass(void) { return NSURLProtocol.class; }
void GBDiagnosticsEvent(NSString *event, NSDictionary *value) {
  if ([event isEqual:@"local-rpc.handled"] && [value[@"path"] isKindOfClass:NSString.class]) {
    [handledPaths addObject:value[@"path"]];
  }
}

#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); exit(1); } } while (0)

static NSMutableURLRequest *makeRequest(NSString *method, NSString *urlString) {
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlString]];
  req.HTTPMethod = method;
  return req;
}

static void verifyLocalEmptyJson(NSURLSession *session, NSString *urlString) {
  NSMutableURLRequest *req = makeRequest(@"POST", urlString);
  req.HTTPBody = [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSInteger status = 0;
  __block NSString *contentType = nil;
  __block NSData *body = nil;
  __block NSError *err = nil;
  [[session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    status = [(NSHTTPURLResponse *)response statusCode];
    contentType = [(NSHTTPURLResponse *)response valueForHTTPHeaderField:@"Content-Type"];
    body = data;
    err = error;
    dispatch_semaphore_signal(sem);
  }] resume];
  CHECK(dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0);
  CHECK(err == nil);
  CHECK(status == 200);
  CHECK([contentType hasPrefix:@"application/json"]);
  CHECK([[[NSString alloc] initWithData:body encoding:NSUTF8StringEncoding] isEqual:@"{}"]);
}

int main(void) { @autoreleasepool {
  handledPaths = [NSMutableArray new];
  NSString *teamUrl = @"https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam";
  NSString *userUrl = @"https://api2.cursor.sh/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings";
  NSString *mcpUrl = @"https://api2.cursor.sh/aiserver.v1.DashboardService/ListMarketplacePlugins";
  NSString *otherUrl = @"https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeams";

  // Unpaired: must not intercept anything.
  GBConnection.shared.deviceToken = nil;
  CHECK(![GBConnectorProtocol canInitWithRequest:makeRequest(@"POST", teamUrl)]);
  CHECK(![GBConnectorProtocol canInitWithRequest:makeRequest(@"POST", userUrl)]);

  // Paired: intercepts POST preference RPCs, ignores GET and unrelated methods.
  GBConnection.shared.serverURL = @"http://127.0.0.1:18080";
  GBConnection.shared.deviceToken = @"test-device-token";
  CHECK([GBConnectorProtocol canInitWithRequest:makeRequest(@"POST", teamUrl)]);
  CHECK([GBConnectorProtocol canInitWithRequest:makeRequest(@"POST", userUrl)]);
  CHECK(![GBConnectorProtocol canInitWithRequest:makeRequest(@"GET", teamUrl)]);
  CHECK(![GBConnectorProtocol canInitWithRequest:makeRequest(@"GET", userUrl)]);
  CHECK(![GBConnectorProtocol canInitWithRequest:makeRequest(@"POST", otherUrl)]);
  CHECK([GBConnectorProtocol canInitWithRequest:makeRequest(@"POST", mcpUrl)]);
  CHECK(GBLocalPreferenceResponse(makeRequest(@"POST", mcpUrl)) == nil);

  NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  config.protocolClasses = @[GBConnectorProtocol.class];
  NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
  verifyLocalEmptyJson(session, teamUrl);
  verifyLocalEmptyJson(session, userUrl);
  CHECK(httpSessionCalls == 0);
  CHECK(handledPaths.count == 2);

  // Foreground configs receive local protocols; background configs are left untouched.
  NSURLSessionConfiguration *ephemeral = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  NSURLSessionConfiguration *patchedEphemeral = GBAddProtocol(ephemeral);
  CHECK([patchedEphemeral.protocolClasses containsObject:GBConnectorProtocol.class]);

  NSURLSessionConfiguration *bg =
      [NSURLSessionConfiguration backgroundSessionConfigurationWithIdentifier:@"dev.grokbot.test.bg"];
  NSArray *bgProtocolsBefore = [bg.protocolClasses copy];
  NSURLSessionConfiguration *bgResult = GBAddProtocol(bg);
  CHECK(bgResult == bg);
  CHECK(![bgResult.protocolClasses containsObject:GBConnectorProtocol.class]);
  CHECK((bgProtocolsBefore == nil && bgResult.protocolClasses == nil) ||
        [bgResult.protocolClasses isEqual:bgProtocolsBefore]);

  NSString *voiceStatusUrl = @"https://local.voice/local/voice/status";
  CHECK([GBVoiceProtocolClass() canInitWithRequest:makeRequest(@"GET", voiceStatusUrl)]);
  CHECK(![GBVoiceProtocolClass() canInitWithRequest:makeRequest(@"POST", voiceStatusUrl)]);
  CHECK(![GBVoiceProtocolClass() canInitWithRequest:makeRequest(@"GET", @"https://api2.cursor.sh/local/voice/status")]);

  NSURLSessionConfiguration *voiceCfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  voiceCfg.protocolClasses = @[GBVoiceProtocolClass()];
  NSURLSession *voiceSession = [NSURLSession sessionWithConfiguration:voiceCfg];

  NSString *(^fetchVoiceStatus)(void) = ^NSString *(void) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSInteger status = 0;
    __block NSString *cacheControl = nil;
    __block NSString *text = nil;
    [[voiceSession dataTaskWithRequest:makeRequest(@"GET", voiceStatusUrl)
                     completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      CHECK(error == nil);
      status = [(NSHTTPURLResponse *)response statusCode];
      cacheControl = [(NSHTTPURLResponse *)response valueForHTTPHeaderField:@"Cache-Control"];
      text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
      dispatch_semaphore_signal(sem);
    }] resume];
    CHECK(dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0);
    CHECK(status == 200);
    CHECK([cacheControl isEqual:@"no-store"]);
    return text;
  };

  mockVoiceHostStatusCode = 200;
  mockVoiceHostBody = @"{\"enabled\":true}";
  CHECK([fetchVoiceStatus() isEqual:@"{\"enabled\":true}"]);
  CHECK([lastForwardedURL isEqual:@"http://127.0.0.1:18080/local/voice/status"]);
  CHECK([lastForwardedAuth isEqual:@"Bearer test-device-token"]);

  mockVoiceHostBody = @"{\"enabled\":false}";
  CHECK([fetchVoiceStatus() isEqual:@"{\"enabled\":false}"]);

  mockVoiceHostStatusCode = 502;
  mockVoiceHostBody = @"bad gateway";
  CHECK([fetchVoiceStatus() isEqual:@"{\"enabled\":false}"]);

  GBConnection.shared.deviceToken = nil;
  mockVoiceHostStatusCode = 200;
  mockVoiceHostBody = @"{\"enabled\":true}";
  CHECK([fetchVoiceStatus() isEqual:@"{\"enabled\":false}"]);

  puts("PASS: iOS Auto-review RPC interception, voice status sync, and background session bypass");
  return 0;
} }
"""


class AutoReviewPreferencesTests(unittest.TestCase):
    def test_source_intercepts_team_and_user_preference_rpcs(self):
        source = (ROOT / 'clients' / 'ios' / 'GBConnectors.m').read_text(encoding='utf-8')
        self.assertIn('/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam', source)
        self.assertIn('/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings', source)
        self.assertIn('GBLocalPreferenceResponse', source)

    def test_native_url_protocol_behavior(self):
        if sys.platform != 'darwin' or not shutil.which('clang'):
            self.skipTest('macOS clang is required for native NSURLProtocol test')
        runtime = ROOT / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='autoreview-tests-', suffix='.noindex', dir=runtime) as temp:
            work = Path(temp)
            (work / 'UIKit').mkdir()
            (work / 'UIKit' / 'UIKit.h').write_text('#import <Foundation/Foundation.h>\n', encoding='utf-8')
            harness = work / 'test.m'
            harness.write_text(OBJC_HARNESS, encoding='utf-8')
            binary = work / 'test-bin'
            subprocess.run(
                [
                    'clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
                    '-Wno-unused-parameter', '-Wno-deprecated-declarations', '-Wno-nullability-completeness',
                    '-I', str(work), '-I', str(ROOT / 'clients' / 'ios'),
                    '-framework', 'Foundation',
                    str(harness), '-o', str(binary),
                ],
                check=True,
                cwd=ROOT / 'tests',
            )
            subprocess.run([str(binary)], check=True, timeout=15)


if __name__ == '__main__':
    unittest.main()
