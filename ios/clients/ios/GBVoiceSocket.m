#import "GBConnection.h"
#import "GBVoiceAudio.h"
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

// Keep the original voice module and its delegate contract. Its bundled
// SocketRocket transport fixes TLS to 1.2; URLSession negotiates modern TLS.
static const void *GBVoiceSocketKey = &GBVoiceSocketKey;
static void (*GBOriginalOpen)(id, SEL);
static void (*GBOriginalClose)(id, SEL, NSInteger, NSString *);
static BOOL (*GBOriginalSendData)(id, SEL, NSData *, NSError **);
static BOOL (*GBOriginalSendString)(id, SEL, NSString *, NSError **);
static BOOL (*GBOriginalPing)(id, SEL, NSData *, NSError **);
static void (*GBOriginalSend)(id, SEL, id);

static id GBObjectIvar(id object, const char *name) {
  Ivar ivar = class_getInstanceVariable([object class], name);
  return ivar ? object_getIvar(object, ivar) : nil;
}
static BOOL GBIsLocalVoiceURL(NSURL *url) {
  NSURL *host = [NSURL URLWithString:GBConnection.shared.serverURL];
  BOOL secure = [host.scheme.lowercaseString isEqual:@"https"];
  return host.host.length && (secure || [host.scheme.lowercaseString isEqual:@"http"]) &&
    [url.scheme.lowercaseString isEqual:secure ? @"wss" : @"ws"] &&
    [url.host.lowercaseString isEqual:host.host.lowercaseString] &&
    [(url.port ?: @(secure ? 443 : 80)) isEqual:(host.port ?: @(secure ? 443 : 80))] &&
    [url.path isEqual:@"/local/voice/realtime"] && !url.user.length && !url.password.length;
}
static void GBDispatchSocket(id socket, void (^callback)(id delegate)) {
  void (^block)(void) = ^{
    id delegate = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(delegate));
    if (delegate) callback(delegate);
  };
  NSOperationQueue *operations = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(delegateOperationQueue));
  dispatch_queue_t queue = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(delegateDispatchQueue));
  if (operations) [operations addOperationWithBlock:block];
  else dispatch_async(queue ?: dispatch_get_main_queue(), block);
}
static void GBSetSocketState(id socket, NSInteger state) {
  ((void (*)(id, SEL, NSInteger))objc_msgSend)(socket, @selector(setReadyState:), state);
}

@interface GBVoiceSocket : NSObject <NSURLSessionWebSocketDelegate>
@property(atomic, weak) id socket;
@property(atomic, strong) NSURLSession *session;
@property(atomic, strong) NSURLSessionWebSocketTask *task;
@property(atomic) BOOL terminal;
@property(atomic) BOOL clientClosed;
@property(atomic) NSInteger closeCode;
@property(atomic, copy) NSString *closeReason;
- (void)start:(id)socket;
- (BOOL)send:(id)value error:(NSError **)error;
- (void)close:(NSInteger)code reason:(NSString *)reason;
- (void)fail:(NSError *)error;
- (void)receive;
@end

@implementation GBVoiceSocket
- (void)start:(id)socket {
  self.socket = socket;
  NSURL *url = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(url));
  NSURLRequest *original = GBObjectIvar(socket, "_urlRequest");
  NSMutableURLRequest *request = [original isKindOfClass:NSURLRequest.class] ?
    original.mutableCopy : [NSMutableURLRequest requestWithURL:url];
  NSArray *protocols = GBObjectIvar(socket, "_requestedProtocols");
  if ([protocols isKindOfClass:NSArray.class] && protocols.count)
    [request setValue:[protocols componentsJoinedByString:@", "] forHTTPHeaderField:@"Sec-WebSocket-Protocol"];
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.TLSMinimumSupportedProtocolVersion = tls_protocol_version_TLSv12;
  NSOperationQueue *queue = [NSOperationQueue new]; queue.maxConcurrentOperationCount = 1;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:queue];
  NSURLSessionWebSocketTask *task = [session webSocketTaskWithRequest:request];
  task.maximumMessageSize = 16 * 1024 * 1024;
  self.session = session;
  self.task = task;
  [task resume];
}
- (BOOL)finish {
  NSURLSession *session = nil;
  @synchronized (self) {
    if (self.terminal) return NO;
    self.terminal = YES;
    session = self.session;
    self.session = nil;
  }
  id socket = self.socket;
  if (socket) GBSetSocketState(socket, 3);
  [session finishTasksAndInvalidate];
  return YES;
}
- (void)completeCloseWithCode:(NSInteger)code reason:(NSString *)reason wasClean:(BOOL)wasClean {
  if (![self finish]) return;
  id socket = self.socket;
  if (socket) GBDispatchSocket(socket, ^(id delegate) {
    SEL selector = @selector(webSocket:didCloseWithCode:reason:wasClean:);
    if ([delegate respondsToSelector:selector])
      ((void (*)(id, SEL, id, NSInteger, id, BOOL))objc_msgSend)(delegate, selector, socket, code, reason, wasClean);
  });
}
- (void)fail:(NSError *)error {
  NSURLSessionWebSocketTask *task = self.task;
  if (![self finish]) return;
  id socket = self.socket;
  if (socket) GBDispatchSocket(socket, ^(id delegate) {
    SEL selector = @selector(webSocket:didFailWithError:);
    if ([delegate respondsToSelector:selector])
      ((void (*)(id, SEL, id, id))objc_msgSend)(delegate, selector, socket, error);
  });
  [task cancel];
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task
    didOpenWithProtocol:(NSString *)protocol {
  if (self.terminal) return;
  id socket = self.socket;
  if (!socket) { [self finish]; [task cancel]; return; }
  GBSetSocketState(socket, 1);
  GBDispatchSocket(socket, ^(id delegate) {
    SEL selector = @selector(webSocketDidOpen:);
    if ([delegate respondsToSelector:selector])
      ((void (*)(id, SEL, id))objc_msgSend)(delegate, selector, socket);
  });
  [self receive];
}
- (void)receive {
  NSURLSessionWebSocketTask *task = self.task;
  if (self.terminal || !task) return;
  [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    if (self.terminal) return;
    if (error) {
      BOOL clientClosed = NO;
      NSInteger closeCode = 0;
      NSString *closeReason = nil;
      @synchronized (self) {
        clientClosed = self.clientClosed;
        closeCode = self.closeCode;
        closeReason = self.closeReason;
      }
      if (clientClosed) {
        BOOL clean = [error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled;
        [self completeCloseWithCode:closeCode reason:closeReason wasClean:clean];
      } else {
        [self fail:error];
      }
      return;
    }
    id socket = self.socket;
    if (!socket) { [self finish]; [task cancel]; return; }
    id value = message.type == NSURLSessionWebSocketMessageTypeString ? message.string : message.data;
    GBDispatchSocket(socket, ^(id delegate) {
      SEL typed = message.type == NSURLSessionWebSocketMessageTypeString ?
        @selector(webSocket:didReceiveMessageWithString:) : @selector(webSocket:didReceiveMessageWithData:);
      SEL selector = [delegate respondsToSelector:typed] ? typed : @selector(webSocket:didReceiveMessage:);
      if ([delegate respondsToSelector:selector])
        ((void (*)(id, SEL, id, id))objc_msgSend)(delegate, selector, socket, value);
    });
    [self receive];
  }];
}
- (BOOL)send:(id)value error:(NSError **)error {
  NSURLSessionWebSocketTask *task = self.task;
  if (self.terminal || !task || task.state != NSURLSessionTaskStateRunning ||
      (![value isKindOfClass:NSString.class] && ![value isKindOfClass:NSData.class])) {
    if (error) *error = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNetworkConnectionLost userInfo:nil];
    return NO;
  }
  NSURLSessionWebSocketMessage *message = [value isKindOfClass:NSString.class] ?
    [[NSURLSessionWebSocketMessage alloc] initWithString:value] :
    [[NSURLSessionWebSocketMessage alloc] initWithData:value];
  [task sendMessage:message completionHandler:^(NSError *failure) {
    if (!failure) return;
    BOOL clientClosed = NO;
    @synchronized (self) { clientClosed = self.clientClosed; }
    if (!clientClosed) [self fail:failure];
  }];
  return YES;
}
- (void)close:(NSInteger)code reason:(NSString *)reason {
  NSURLSessionWebSocketTask *task = nil;
  @synchronized (self) {
    if (self.terminal) return;
    self.closeCode = code;
    self.closeReason = [reason copy];
    self.clientClosed = YES;
    task = self.task;
  }
  id socket = self.socket;
  if (socket) GBSetSocketState(socket, 2);
  if (task) {
    [task cancelWithCloseCode:code reason:[reason dataUsingEncoding:NSUTF8StringEncoding]];
  } else {
    [self completeCloseWithCode:code reason:reason wasClean:YES];
  }
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task
    didCloseWithCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
  NSString *text = reason ? [[NSString alloc] initWithData:reason encoding:NSUTF8StringEncoding] : nil;
  [self completeCloseWithCode:code reason:text wasClean:YES];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  BOOL clientClosed = NO;
  NSInteger closeCode = 0;
  NSString *closeReason = nil;
  @synchronized (self) {
    clientClosed = self.clientClosed;
    closeCode = self.closeCode;
    closeReason = self.closeReason;
  }
  if (clientClosed) {
    BOOL clean = !error || ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled);
    [self completeCloseWithCode:closeCode reason:closeReason wasClean:clean];
    return;
  }
  if (error) [self fail:error];
  else [self completeCloseWithCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil wasClean:YES];
}
@end

static void GBOpenSocket(id socket, SEL selector) {
  GBVoiceAudioObserveSocket(socket);
  NSURL *url = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(url));
  if (!GBIsLocalVoiceURL(url)) { GBOriginalOpen(socket, selector); return; }
  if (objc_getAssociatedObject(socket, GBVoiceSocketKey)) return;
  GBVoiceSocket *context = [GBVoiceSocket new];
  objc_setAssociatedObject(socket, GBVoiceSocketKey, context, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [context start:socket];
}
static void GBCloseSocket(id socket, SEL selector, NSInteger code, NSString *reason) {
  GBVoiceSocket *context = objc_getAssociatedObject(socket, GBVoiceSocketKey);
  if (context) [context close:code reason:reason]; else GBOriginalClose(socket, selector, code, reason);
}
static BOOL GBSendData(id socket, SEL selector, NSData *data, NSError **error) {
  GBVoiceSocket *context = objc_getAssociatedObject(socket, GBVoiceSocketKey);
  return context ? [context send:data error:error] : GBOriginalSendData(socket, selector, data, error);
}
static BOOL GBSendString(id socket, SEL selector, NSString *string, NSError **error) {
  GBVoiceSocket *context = objc_getAssociatedObject(socket, GBVoiceSocketKey);
  return context ? [context send:string error:error] : GBOriginalSendString(socket, selector, string, error);
}
static void GBSend(id socket, SEL selector, id data) {
  GBVoiceSocket *context = objc_getAssociatedObject(socket, GBVoiceSocketKey);
  if (context) [context send:data error:nil]; else GBOriginalSend(socket, selector, data);
}
static BOOL GBPing(id socket, SEL selector, NSData *data, NSError **error) {
  GBVoiceSocket *context = objc_getAssociatedObject(socket, GBVoiceSocketKey);
  if (!context) return GBOriginalPing(socket, selector, data, error);
  NSURLSessionWebSocketTask *task = context.task;
  if (context.terminal || !task || task.state != NSURLSessionTaskStateRunning) {
    if (error) *error = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNetworkConnectionLost userInfo:nil];
    return NO;
  }
  [task sendPingWithPongReceiveHandler:^(NSError *failure) {
    if (failure && !context.clientClosed) [context fail:failure];
  }];
  return YES;
}
__attribute__((constructor)) static void GBInstallVoiceSocket(void) {
  Class cls = NSClassFromString(@"SRWebSocket");
  Method open = class_getInstanceMethod(cls, @selector(open));
  Method close = class_getInstanceMethod(cls, @selector(closeWithCode:reason:));
  Method data = class_getInstanceMethod(cls, @selector(sendData:error:));
  Method string = class_getInstanceMethod(cls, @selector(sendString:error:));
  Method send = class_getInstanceMethod(cls, @selector(send:));
  Method ping = class_getInstanceMethod(cls, @selector(sendPing:error:));
  if (!open || !close || !data || !string || !send || !ping) return;
  GBOriginalOpen = (void *)method_setImplementation(open, (IMP)GBOpenSocket);
  GBOriginalClose = (void *)method_setImplementation(close, (IMP)GBCloseSocket);
  GBOriginalSendData = (void *)method_setImplementation(data, (IMP)GBSendData);
  GBOriginalSendString = (void *)method_setImplementation(string, (IMP)GBSendString);
  GBOriginalSend = (void *)method_setImplementation(send, (IMP)GBSend);
  GBOriginalPing = (void *)method_setImplementation(ping, (IMP)GBPing);
}
