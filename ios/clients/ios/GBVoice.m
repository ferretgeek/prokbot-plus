#import "GBVoice.h"
#import "GBVoiceAudio.h"
#import "GBVoiceCredential.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"

@interface GBVoiceProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(atomic,assign) BOOL cancelled;
@end
@implementation GBVoiceProtocol
+ (BOOL)isVoiceStatusRequest:(NSURLRequest *)request {
  return [request.HTTPMethod isEqual:@"GET"] &&
    [request.URL.host.lowercaseString isEqual:@"local.voice"] &&
    [request.URL.path isEqual:@"/local/voice/status"];
}
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  if ([self isVoiceStatusRequest:request]) return YES;
  return [request.HTTPMethod isEqual:@"POST"] &&
    [request.URL.path isEqual:@"/aiserver.v1.GrokBotService/MintSandVoiceCallSecret"];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)finishJSON:(NSData *)body status:(NSInteger)status {
  NSHTTPURLResponse *original = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status
    HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type":@"application/json", @"Cache-Control":@"no-store"}];
  [self.client URLProtocol:self didReceiveResponse:original cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  if (body.length) [self.client URLProtocol:self didLoadData:body];
  [self.client URLProtocolDidFinishLoading:self];
}
- (void)fail:(NSString *)message code:(NSInteger)code {
  [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"GrokBotVoice" code:code
    userInfo:@{NSLocalizedDescriptionKey:message}]];
}
- (void)startLoading {
  GBConnection *connection = GBConnection.shared;
  NSString *serverURL = connection.serverURL, *token = connection.deviceToken;
  if ([GBVoiceProtocol isVoiceStatusRequest:self.request]) {
    NSData *disabledBody = [@"{\"enabled\":false}" dataUsingEncoding:NSUTF8StringEncoding];
    NSURL *statusURL = (serverURL.length && token.length)
      ? [NSURL URLWithString:[serverURL stringByAppendingString:@"/local/voice/status"]]
      : nil;
    if (!statusURL) {
      [self finishJSON:disabledBody status:200];
      return;
    }
    NSMutableURLRequest *statusReq = [NSMutableURLRequest requestWithURL:statusURL];
    statusReq.HTTPMethod = @"GET";
    statusReq.timeoutInterval = 15;
    statusReq.allHTTPHeaderFields = @{
      @"Accept":@"application/json",
      @"Authorization":[@"Bearer " stringByAppendingString:token]
    };
    self.task = [GBHTTPSession() dataTaskWithRequest:statusReq completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      if (self.cancelled) return;
      BOOL enabled = NO;
      if (!error && [response isKindOfClass:NSHTTPURLResponse.class]) {
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        if (http.statusCode >= 200 && http.statusCode < 300 && data.length && data.length <= 4096) {
          id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
          if ([parsed isKindOfClass:NSDictionary.class] && [parsed[@"enabled"] isKindOfClass:NSNumber.class])
            enabled = [parsed[@"enabled"] boolValue];
        }
      }
      GBDiagnosticsEvent(@"voice.status.response", @{@"enabled":@(enabled)});
      NSData *reply = [(enabled ? @"{\"enabled\":true}" : @"{\"enabled\":false}") dataUsingEncoding:NSUTF8StringEncoding];
      [self finishJSON:reply status:200];
    }];
    [self.task resume];
    return;
  }
  if (!serverURL.length || !token.length) {
    [self fail:GBL(@"请先连接 Host。", @"Connect to Host first.") code:401]; return;
  }
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *bytes = [NSMutableData data]; uint8_t buffer[4096]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (bytes.length + count > 16384) { [stream close]; [self fail:@"Invalid voice request" code:400]; return; }
      [bytes appendBytes:buffer length:count];
    }
    [stream close];
    if (count < 0) { [self fail:@"Invalid voice request" code:400]; return; }
    body = bytes;
  }
  id input = body.length <= 16384 && body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
  NSString *agentId = [input isKindOfClass:NSDictionary.class] ? input[@"agentId"] : nil;
  if (![agentId isKindOfClass:NSString.class] || !agentId.length || agentId.length > 256) {
    [self fail:GBL(@"请选择 Bot。", @"Choose a Bot.") code:400]; return;
  }
  NSURL *targetURL = [NSURL URLWithString:[serverURL stringByAppendingString:@"/local/voice/session"]];
  if (!targetURL) {
    [self fail:GBL(@"无法连接语音服务。", @"Could not connect to the voice service.") code:400]; return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:targetURL];
  request.HTTPMethod = @"POST"; request.timeoutInterval = 30;
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Accept":@"application/json",
    @"Authorization":[@"Bearer " stringByAppendingString:token]};
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"agentId":agentId,
    @"audioProcessing":GBVoiceAudioAvailable() ? @"native-aec3-buffered-v1" : @"legacy"} options:0 error:nil];
  GBDiagnosticsEvent(@"voice.session.request", @{});
  self.task = [GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]];
      return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    if (http.statusCode >= 200 && http.statusCode < 300) {
      id credential = data.length && data.length <= 16384 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if (!GBVoiceCredentialIsValid(credential, serverURL)) {
        [self fail:GBL(@"无法连接语音服务。", @"Could not connect to the voice service.") code:502]; return;
      }
    }
    GBDiagnosticsEvent(@"voice.session.response", @{@"status":@(http.statusCode)});
    NSHTTPURLResponse *original = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:http.statusCode
      HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type":@"application/json"}];
    [self.client URLProtocol:self didReceiveResponse:original cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
Class GBVoiceProtocolClass(void) { return GBVoiceProtocol.class; }
