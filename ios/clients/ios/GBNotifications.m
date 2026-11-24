#import "GBNotifications.h"
#import "GBConnection.h"
#import "GBPush.h"
#import <UserNotifications/UserNotifications.h>
#include <string.h>

@interface GBNotifications () <NSURLSessionDataDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSMutableData *buffer;
@property(nonatomic, assign) NSUInteger generation;
@property(nonatomic, assign) NSUInteger retryCount;
@property(nonatomic, strong) NSString *eventId;
@property(nonatomic, strong) NSString *eventType;
@property(nonatomic, strong) NSMutableArray *eventLines;
@end
@implementation GBNotifications
+ (instancetype)shared {
  static GBNotifications *v;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    v = [self new];
  });
  return v;
}
- (void)stop {
  self.generation++;
  [self.task cancel];
  self.task = nil;
  [self.session invalidateAndCancel];
  self.session = nil;
  self.buffer = nil;
}
- (void)start {
  NSString *base = GBConnection.shared.serverURL;
  NSString *token = GBConnection.shared.deviceToken;
  if (self.task && self.task.state == NSURLSessionTaskStateRunning && base.length && token.length &&
      [self.task.originalRequest.URL.absoluteString isEqual:[base stringByAppendingString:@"/notifications/events"]] &&
      [[self.task.originalRequest valueForHTTPHeaderField:@"Authorization"] isEqual:[@"Bearer " stringByAppendingString:token]])
    return;
  self.retryCount = 0;
  [self connect];
}
- (void)connect {
  NSString *base = GBConnection.shared.serverURL;
  NSString *token = GBConnection.shared.deviceToken;
  if (self.task && self.task.state == NSURLSessionTaskStateRunning && base.length && token.length &&
      [self.task.originalRequest.URL.absoluteString isEqual:[base stringByAppendingString:@"/notifications/events"]] &&
      [[self.task.originalRequest valueForHTTPHeaderField:@"Authorization"] isEqual:[@"Bearer " stringByAppendingString:token]])
    return;
  [self stop];
  if (!base.length || !token.length ||
      UIApplication.sharedApplication.applicationState != UIApplicationStateActive)
    return;
  NSURL *url = [NSURL URLWithString:[base stringByAppendingString:@"/notifications/events"]];
  if (!url)
    return;
  self.buffer = [NSMutableData data];
  self.eventLines = [NSMutableArray array];
  NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  config.timeoutIntervalForRequest = 120;
  config.timeoutIntervalForResource = 86400;
  self.session = [NSURLSession sessionWithConfiguration:config
                                               delegate:self
                                          delegateQueue:NSOperationQueue.mainQueue];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  [request setValue:[@"Bearer " stringByAppendingString:token]
      forHTTPHeaderField:@"Authorization"];
  [request setValue:@"text/event-stream" forHTTPHeaderField:@"Accept"];
  [request setValue:@"1" forHTTPHeaderField:@"X-GrokBot-Foreground"];
  NSString *last =
      [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"GrokBotLocal.notificationCursor"]
          objectForKey:base];
  if ([last isKindOfClass:NSString.class] && last.length)
    [request setValue:last forHTTPHeaderField:@"Last-Event-ID"];
  self.task = [self.session dataTaskWithRequest:request];
  [self.task resume];
}
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
      ? ((NSHTTPURLResponse *)response).statusCode : 0;
  if (status == 401) {
    completionHandler(NSURLSessionResponseCancel);
    [self stop];
    [GBConnection.shared show];
    return;
  }
  if (status == 200)
    self.retryCount = 0;
  completionHandler(status == 200 ? NSURLSessionResponseAllow : NSURLSessionResponseCancel);
}
- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)task
    didReceiveData:(NSData *)data {
  if (task != self.task)
    return;
  [self.buffer appendData:data];
  if (self.buffer.length > 1024 * 1024) {
    [self stop];
    return;
  }
  const uint8_t *bytes = self.buffer.bytes;
  NSUInteger total = self.buffer.length;
  NSUInteger offset = 0;
  while (offset < total) {
    const uint8_t *nl = memchr(bytes + offset, '\n', total - offset);
    if (!nl)
      break;
    NSUInteger lineLen = (NSUInteger)(nl - (bytes + offset));
    if (lineLen > 0 && bytes[offset + lineLen - 1] == '\r')
      lineLen--;
    NSString *line = [[NSString alloc] initWithBytes:bytes + offset
                                              length:lineLen
                                            encoding:NSUTF8StringEncoding];
    offset = (NSUInteger)(nl - bytes) + 1;
    if (!line)
      continue;
    if (!line.length) {
      [self event];
      self.eventType = nil;
      self.eventId = nil;
      [self.eventLines removeAllObjects];
    } else if ([line hasPrefix:@"data:"])
      [self.eventLines
          addObject:[[line substringFromIndex:5]
                        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]];
    else if ([line hasPrefix:@"event:"])
      self.eventType = [[line substringFromIndex:6]
          stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    else if ([line hasPrefix:@"id:"])
      self.eventId = [[line substringFromIndex:3]
          stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  }
  if (offset > 0 && self.buffer)
    [self.buffer replaceBytesInRange:NSMakeRange(0, offset) withBytes:NULL length:0];
}
- (void)event {
  if (![self.eventType isEqual:@"notification"] || !self.eventLines.count)
    return;
  NSData *data =
      [[self.eventLines componentsJoinedByString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![parsed isKindOfClass:NSDictionary.class])
    return;
  NSDictionary *n = parsed;
  NSString *identity = [n[@"id"] isKindOfClass:NSString.class] ? n[@"id"] : nil;
  if (!identity.length)
    return;
  NSString *base = GBConnection.shared.serverURL;
  if (!base.length)
    return;
  NSMutableDictionary *cursors =
      [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"GrokBotLocal.notificationCursor"]
          mutableCopy]
          ?: [NSMutableDictionary dictionary];
  cursors[base] = self.eventId ?: identity;
  [NSUserDefaults.standardUserDefaults setObject:cursors forKey:@"GrokBotLocal.notificationCursor"];
  GBReceiveLocalNotification(n);
}
- (void)URLSession:(NSURLSession *)session
                    task:(NSURLSessionTask *)task
    didCompleteWithError:(NSError *)error {
  if (task != self.task)
    return;
  self.task = nil;
  [self.session invalidateAndCancel];
  self.session = nil;
  self.buffer = nil;
  NSUInteger generation = self.generation;
  double delay = MIN(60.0, 3.0 * (1u << MIN(self.retryCount, 4u)));
  if (self.retryCount < 8)
    self.retryCount++;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (self.generation == generation)
                     [self connect];
                 });
}
@end
