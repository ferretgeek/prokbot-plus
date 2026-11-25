#import "GBPerf.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"
#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <mach/mach_time.h>
#import <math.h>
#import <objc/runtime.h>

BOOL GBPerfActive = NO;
BOOL GBPerfLayoutHooksDisabled = NO;

static mach_timebase_info_data_t GBPerfTimebase;
uint64_t GBPerfNow(void) { return mach_absolute_time(); }
static double GBPerfMs(uint64_t ticks) {
  if (!GBPerfTimebase.denom) mach_timebase_info(&GBPerfTimebase);
  return (double)ticks * GBPerfTimebase.numer / GBPerfTimebase.denom / 1e6;
}

typedef struct {
  uint64_t layoutCalls, entryCalls, labelReads;
  uint64_t originalTicks, hookTicks, labelTicks, maxHookTicks, maxLabelTicks;
  uint64_t frameHookTicks, frameOriginalTicks, frameLayoutCalls;
  uint64_t maxFrameHookTicks, maxFrameOriginalTicks, maxFrameLayoutCalls;
  uint64_t framesWithLayout, framesHookOver2ms, framesHookOver4ms;
  uint64_t mounts, mountTicks, maxMountTicks, frameMountTicks, maxFrameMountTicks, framesWithMount;
  uint64_t layoutMetricsUpdates, propsUpdates;
} GBPerfCounters;
static GBPerfCounters GBPerfC;
static NSMutableArray<NSNumber *> *GBPerfFrameMs;
static NSUInteger GBPerfHitches;
static double GBPerfHitchMs, GBPerfExpectedMsSum;
static CADisplayLink *GBPerfLink;
static CFTimeInterval GBPerfLastTimestamp, GBPerfLastTarget, GBPerfStartTime;
static NSTimeInterval GBPerfDuration = 15;
static BOOL GBPerfPrompting;
static NSString *GBPerfScenario = @"scroll";
static CFMutableDictionaryRef GBPerfClassCounts;

// React Native Fabric probes. All arguments are C++ references or by-value
// non-trivial types, which the arm64 ABI passes as pointers, so forwarding the
// pointer unchanged is exact. Counting happens only while a session is active.
static IMP GBPerfOriginalPerform, GBPerfOriginalLayoutMetrics, GBPerfOriginalProps;
static Method GBPerfPerformMethod, GBPerfLayoutMetricsMethod, GBPerfPropsMethod;
static BOOL GBPerfProbesInstalled;
static void GBPerfPerform(id self, SEL cmd, void *coordinator) {
  if (!GBPerfActive || !NSThread.isMainThread) {
    ((void (*)(id, SEL, void *))GBPerfOriginalPerform)(self, cmd, coordinator);
    return;
  }
  uint64_t t0 = mach_absolute_time();
  ((void (*)(id, SEL, void *))GBPerfOriginalPerform)(self, cmd, coordinator);
  uint64_t dt = mach_absolute_time() - t0;
  GBPerfC.mounts++;
  GBPerfC.mountTicks += dt;
  GBPerfC.frameMountTicks += dt;
  if (dt > GBPerfC.maxMountTicks) GBPerfC.maxMountTicks = dt;
}
static void GBPerfLayoutMetrics(id self, SEL cmd, const void *metrics, const void *old) {
  if (GBPerfActive) GBPerfC.layoutMetricsUpdates++;
  ((void (*)(id, SEL, const void *, const void *))GBPerfOriginalLayoutMetrics)(self, cmd, metrics, old);
}
static void GBPerfProps(id self, SEL cmd, const void *props, const void *old) {
  if (GBPerfActive) GBPerfC.propsUpdates++;
  ((void (*)(id, SEL, const void *, const void *))GBPerfOriginalProps)(self, cmd, props, old);
}
static void GBPerfInstallProbes(void) {
  if (GBPerfProbesInstalled) return;
  GBPerfPerformMethod = class_getInstanceMethod(NSClassFromString(@"RCTMountingManager"),
                                                sel_registerName("performTransaction:"));
  if (GBPerfPerformMethod)
    GBPerfOriginalPerform = method_setImplementation(GBPerfPerformMethod, (IMP)GBPerfPerform);
  Class view = NSClassFromString(@"RCTViewComponentView");
  GBPerfLayoutMetricsMethod = class_getInstanceMethod(view, sel_registerName("updateLayoutMetrics:oldLayoutMetrics:"));
  if (GBPerfLayoutMetricsMethod)
    GBPerfOriginalLayoutMetrics = method_setImplementation(GBPerfLayoutMetricsMethod, (IMP)GBPerfLayoutMetrics);
  GBPerfPropsMethod = class_getInstanceMethod(view, sel_registerName("updateProps:oldProps:"));
  if (GBPerfPropsMethod)
    GBPerfOriginalProps = method_setImplementation(GBPerfPropsMethod, (IMP)GBPerfProps);
  GBPerfProbesInstalled = YES;
}
static void GBPerfUninstallProbes(void) {
  if (!GBPerfProbesInstalled) return;
  if (GBPerfPerformMethod && GBPerfOriginalPerform)
    method_setImplementation(GBPerfPerformMethod, GBPerfOriginalPerform);
  if (GBPerfLayoutMetricsMethod && GBPerfOriginalLayoutMetrics)
    method_setImplementation(GBPerfLayoutMetricsMethod, GBPerfOriginalLayoutMetrics);
  if (GBPerfPropsMethod && GBPerfOriginalProps)
    method_setImplementation(GBPerfPropsMethod, GBPerfOriginalProps);
  GBPerfOriginalPerform = NULL;
  GBPerfOriginalLayoutMetrics = NULL;
  GBPerfOriginalProps = NULL;
  GBPerfPerformMethod = NULL;
  GBPerfLayoutMetricsMethod = NULL;
  GBPerfPropsMethod = NULL;
  GBPerfProbesInstalled = NO;
}

void GBPerfRecordLayoutClass(Class cls) {
  if (!GBPerfClassCounts) return;
  const void *key = (__bridge const void *)cls;
  intptr_t count = (intptr_t)CFDictionaryGetValue(GBPerfClassCounts, key);
  CFDictionarySetValue(GBPerfClassCounts, key, (const void *)(count + 1));
}

void GBPerfRecordLayout(uint64_t originalTicks, uint64_t hookTicks, BOOL entry) {
  GBPerfC.layoutCalls++;
  if (entry) GBPerfC.entryCalls++;
  GBPerfC.originalTicks += originalTicks;
  GBPerfC.hookTicks += hookTicks;
  if (hookTicks > GBPerfC.maxHookTicks) GBPerfC.maxHookTicks = hookTicks;
  GBPerfC.frameHookTicks += hookTicks;
  GBPerfC.frameOriginalTicks += originalTicks;
  GBPerfC.frameLayoutCalls++;
}

void GBPerfRecordLabelRead(uint64_t ticks) {
  GBPerfC.labelReads++;
  GBPerfC.labelTicks += ticks;
  if (ticks > GBPerfC.maxLabelTicks) GBPerfC.maxLabelTicks = ticks;
}

static double GBPerfPercentile(NSArray<NSNumber *> *sorted, double p) {
  if (!sorted.count) return 0;
  NSUInteger index = MIN(sorted.count - 1, (NSUInteger)(p * (sorted.count - 1) + 0.5));
  return sorted[index].doubleValue;
}

static double GBPerfRound(double value) { return round(value * 100) / 100; }

static void GBPerfCloseFrameBucket(void) {
  if (GBPerfC.frameLayoutCalls) GBPerfC.framesWithLayout++;
  double hookMs = GBPerfMs(GBPerfC.frameHookTicks);
  if (hookMs > 2.0) GBPerfC.framesHookOver2ms++;
  if (hookMs > 4.0) GBPerfC.framesHookOver4ms++;
  if (GBPerfC.frameHookTicks > GBPerfC.maxFrameHookTicks) GBPerfC.maxFrameHookTicks = GBPerfC.frameHookTicks;
  if (GBPerfC.frameOriginalTicks > GBPerfC.maxFrameOriginalTicks) GBPerfC.maxFrameOriginalTicks = GBPerfC.frameOriginalTicks;
  if (GBPerfC.frameLayoutCalls > GBPerfC.maxFrameLayoutCalls) GBPerfC.maxFrameLayoutCalls = GBPerfC.frameLayoutCalls;
  if (GBPerfC.frameMountTicks) GBPerfC.framesWithMount++;
  if (GBPerfC.frameMountTicks > GBPerfC.maxFrameMountTicks) GBPerfC.maxFrameMountTicks = GBPerfC.frameMountTicks;
  GBPerfC.frameHookTicks = GBPerfC.frameOriginalTicks = GBPerfC.frameLayoutCalls = GBPerfC.frameMountTicks = 0;
}

static BOOL GBPerfPresent(NSString *title, NSString *message, NSArray<UIAlertAction *> *actions) {
  UIViewController *top = GBTopController();
  if (!top || [top isKindOfClass:UIAlertController.class] || top.isBeingDismissed ||
      top.presentedViewController != nil || !top.viewIfLoaded.window)
    return NO;
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:title message:message
                                                          preferredStyle:UIAlertControllerStyleAlert];
  for (UIAlertAction *action in actions) [alert addAction:action];
  [top presentViewController:alert animated:YES completion:nil];
  return alert.presentingViewController != nil;
}

static void GBPerfPruneOldFiles(NSFileManager *fm, NSURL *dir, NSUInteger keepCount) {
  NSArray<NSURL *> *items = [fm contentsOfDirectoryAtURL:dir
                              includingPropertiesForKeys:@[NSURLContentModificationDateKey]
                                                 options:NSDirectoryEnumerationSkipsHiddenFiles
                                                   error:nil];
  NSMutableArray<NSURL *> *perfFiles = [NSMutableArray array];
  for (NSURL *item in items) {
    NSString *name = item.lastPathComponent;
    if ([name hasPrefix:@"perf-"] && [name hasSuffix:@".json"])
      [perfFiles addObject:item];
  }
  if (perfFiles.count <= keepCount) return;
  [perfFiles sortUsingComparator:^NSComparisonResult(NSURL *a, NSURL *b) {
    NSDate *da = nil, *db = nil;
    [a getResourceValue:&da forKey:NSURLContentModificationDateKey error:nil];
    [b getResourceValue:&db forKey:NSURLContentModificationDateKey error:nil];
    return [(db ?: NSDate.distantPast) compare:(da ?: NSDate.distantPast)];
  }];
  for (NSUInteger i = keepCount; i < perfFiles.count; i++)
    [fm removeItemAtURL:perfFiles[i] error:nil];
}

static void GBPerfFinish(void) {
  [GBPerfLink invalidate];
  GBPerfLink = nil;
  GBPerfUninstallProbes();
  GBPerfCloseFrameBucket();
  BOOL hooksOff = GBPerfLayoutHooksDisabled;
  GBPerfActive = NO;
  GBPerfLayoutHooksDisabled = NO;

  NSArray<NSNumber *> *sorted = [GBPerfFrameMs sortedArrayUsingSelector:@selector(compare:)];
  double seconds = MAX(0.001, GBPerfExpectedMsSum / 1000.0);
  NSUInteger frames = sorted.count;
  double expectedFrameMs = frames ? GBPerfExpectedMsSum / frames : 0;
  NSDictionary *summary = @{
    @"schema": @"grokbot-perf/1",
    @"hooks": hooksOff ? @"off" : @"on",
    @"seconds": @(GBPerfRound(seconds)),
    @"device": @{@"model": UIDevice.currentDevice.model ?: @"",
                 @"system": UIDevice.currentDevice.systemVersion ?: @"",
                 @"maxFps": @(UIScreen.mainScreen.maximumFramesPerSecond)},
    @"app": [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
    @"frames": @{@"count": @(frames),
                 @"expectedMs": @(GBPerfRound(expectedFrameMs)),
                 @"p50Ms": @(GBPerfRound(GBPerfPercentile(sorted, 0.50))),
                 @"p95Ms": @(GBPerfRound(GBPerfPercentile(sorted, 0.95))),
                 @"p99Ms": @(GBPerfRound(GBPerfPercentile(sorted, 0.99))),
                 @"maxMs": @(GBPerfRound(sorted.lastObject.doubleValue)),
                 @"hitches": @(GBPerfHitches),
                 @"hitchMsPerSecond": @(GBPerfRound(GBPerfHitchMs / seconds))},
    @"layout": @{@"calls": @(GBPerfC.layoutCalls),
                 @"entryCalls": @(GBPerfC.entryCalls),
                 @"callsPerSecond": @(GBPerfRound(GBPerfC.layoutCalls / seconds)),
                 @"originalMs": @(GBPerfRound(GBPerfMs(GBPerfC.originalTicks))),
                 @"hookMs": @(GBPerfRound(GBPerfMs(GBPerfC.hookTicks))),
                 @"hookMaxCallMs": @(GBPerfRound(GBPerfMs(GBPerfC.maxHookTicks))),
                 @"maxFrameHookMs": @(GBPerfRound(GBPerfMs(GBPerfC.maxFrameHookTicks))),
                 @"maxFrameOriginalMs": @(GBPerfRound(GBPerfMs(GBPerfC.maxFrameOriginalTicks))),
                 @"maxFrameCalls": @(GBPerfC.maxFrameLayoutCalls),
                 @"framesWithLayout": @(GBPerfC.framesWithLayout),
                 @"framesHookOver2ms": @(GBPerfC.framesHookOver2ms),
                 @"framesHookOver4ms": @(GBPerfC.framesHookOver4ms)},
    @"labels": @{@"reads": @(GBPerfC.labelReads),
                 @"totalMs": @(GBPerfRound(GBPerfMs(GBPerfC.labelTicks))),
                 @"maxMs": @(GBPerfRound(GBPerfMs(GBPerfC.maxLabelTicks)))},
  };
  NSMutableArray<NSDictionary *> *classes = [NSMutableArray array];
  if (GBPerfClassCounts) {
    CFIndex n = CFDictionaryGetCount(GBPerfClassCounts);
    const void **keys = malloc(sizeof(void *) * (size_t)MAX(n, 1));
    const void **values = malloc(sizeof(void *) * (size_t)MAX(n, 1));
    CFDictionaryGetKeysAndValues(GBPerfClassCounts, keys, values);
    for (CFIndex i = 0; i < n; i++)
      [classes addObject:@{@"class": NSStringFromClass((__bridge Class)keys[i]) ?: @"?", @"calls": @((intptr_t)values[i])}];
    free(keys);
    free(values);
    CFRelease(GBPerfClassCounts);
    GBPerfClassCounts = NULL;
    [classes sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [b[@"calls"] compare:a[@"calls"]]; }];
    if (classes.count > 8) [classes removeObjectsInRange:NSMakeRange(8, classes.count - 8)];
  }
  NSMutableDictionary *full = [summary mutableCopy];
  full[@"scenario"] = GBPerfScenario;
  full[@"mount"] = @{@"transactions": @(GBPerfC.mounts),
                     @"perSecond": @(GBPerfRound(GBPerfC.mounts / seconds)),
                     @"totalMs": @(GBPerfRound(GBPerfMs(GBPerfC.mountTicks))),
                     @"maxMs": @(GBPerfRound(GBPerfMs(GBPerfC.maxMountTicks))),
                     @"maxFrameMs": @(GBPerfRound(GBPerfMs(GBPerfC.maxFrameMountTicks))),
                     @"framesWithMount": @(GBPerfC.framesWithMount),
                     @"layoutMetricsUpdates": @(GBPerfC.layoutMetricsUpdates),
                     @"propsUpdates": @(GBPerfC.propsUpdates)};
  full[@"topLayoutClasses"] = classes;
  summary = full;
  NSData *json = [NSJSONSerialization dataWithJSONObject:summary options:NSJSONWritingSortedKeys error:nil];
  NSString *text = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"{}";
  NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject
      URLByAppendingPathComponent:@"HostValidation" isDirectory:YES];
  if (dir) {
    NSFileManager *fm = NSFileManager.defaultManager;
    [fm createDirectoryAtURL:dir
        withIntermediateDirectories:YES
                  attributes:@{
                    NSFileProtectionKey :
                        NSFileProtectionCompleteUntilFirstUserAuthentication
                  }
                       error:nil];
    GBPerfPruneOldFiles(fm, dir, 9);
    NSString *name = [NSString stringWithFormat:@"perf-%@-%.0f.json", hooksOff ? @"off" : @"on", NSDate.date.timeIntervalSince1970];
    [json writeToURL:[dir URLByAppendingPathComponent:name]
             options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication
               error:nil];
  }
  NSString *message = [NSString stringWithFormat:
      GBL(@"\n帧数 %lu（目标 %.1f ms/帧）\n掉帧 %lu 次，卡顿 %.1f ms/秒\n最长一帧 %.1f ms，P95 %.1f ms\n布局回调 %llu 次，插件耗时 %.1f ms\n单帧插件最大 %.2f ms，超过 4ms 的帧 %llu 个\n读取文字标签 %llu 次，共 %.1f ms\nRN 提交 %llu 次，共 %.1f ms，单帧最多 %.1f ms",
          @"\nFrames %lu (target %.1f ms)\nHitches %lu, %.1f ms/s\nLongest %.1f ms, P95 %.1f ms\nLayout hooks %llu, plugin %.1f ms\nMax plugin per frame %.2f ms, frames over 4ms %llu\nLabel reads %llu, %.1f ms\nRN commits %llu, %.1f ms, max per frame %.1f ms"),
      (unsigned long)frames, expectedFrameMs, (unsigned long)GBPerfHitches, GBPerfHitchMs / seconds,
      sorted.lastObject.doubleValue, GBPerfPercentile(sorted, 0.95),
      (unsigned long long)GBPerfC.layoutCalls, GBPerfMs(GBPerfC.hookTicks), GBPerfMs(GBPerfC.maxFrameHookTicks),
      (unsigned long long)GBPerfC.framesHookOver4ms,
      (unsigned long long)GBPerfC.labelReads, GBPerfMs(GBPerfC.labelTicks),
      (unsigned long long)GBPerfC.mounts, GBPerfMs(GBPerfC.mountTicks), GBPerfMs(GBPerfC.maxFrameMountTicks)];
  NSString *title = [GBPerfScenario isEqualToString:@"idle"]
      ? GBL(@"静止记录完成（插件布局回调：开）", @"Idle recording done (layout hooks ON)")
      : (hooksOff ? GBL(@"滑动性能记录完成（插件布局回调：关）", @"Scroll recording done (layout hooks OFF)")
                  : GBL(@"滑动性能记录完成（插件布局回调：开）", @"Scroll recording done (layout hooks ON)"));
  GBPerfPresent(title, message, @[
    [UIAlertAction actionWithTitle:GBL(@"复制结果", @"Copy result") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
      UIPasteboard.generalPasteboard.string = text;
    }],
    [UIAlertAction actionWithTitle:GBL(@"关闭", @"Close") style:UIAlertActionStyleCancel handler:nil],
  ]);
}

@interface GBPerfTicker : NSObject
@end
@implementation GBPerfTicker
+ (instancetype)shared {
  static GBPerfTicker *ticker;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ ticker = [GBPerfTicker new]; });
  return ticker;
}
- (void)tick:(CADisplayLink *)link {
  if (GBPerfLastTimestamp > 0) {
    double actual = (link.timestamp - GBPerfLastTimestamp) * 1000.0;
    double expected = (GBPerfLastTarget - GBPerfLastTimestamp) * 1000.0;
    if (expected <= 0) expected = 1000.0 / MAX(1, UIScreen.mainScreen.maximumFramesPerSecond);
    [GBPerfFrameMs addObject:@(actual)];
    GBPerfExpectedMsSum += expected;
    if (actual > expected * 1.5) {
      GBPerfHitches++;
      GBPerfHitchMs += actual - expected;
    }
    GBPerfCloseFrameBucket();
  } else {
    GBPerfStartTime = link.timestamp;
    GBPerfC.frameHookTicks = GBPerfC.frameOriginalTicks = GBPerfC.frameLayoutCalls = 0;
  }
  GBPerfLastTimestamp = link.timestamp;
  GBPerfLastTarget = link.targetTimestamp;
  if (link.timestamp - GBPerfStartTime >= GBPerfDuration) GBPerfFinish();
}
@end

static void GBPerfStart(BOOL hooksOff, NSTimeInterval seconds, NSString *scenario) {
  if (GBPerfActive) return;
  GBPerfInstallProbes();
  memset(&GBPerfC, 0, sizeof(GBPerfC));
  GBPerfScenario = scenario ?: @"scroll";
  if (GBPerfClassCounts) CFRelease(GBPerfClassCounts);
  GBPerfClassCounts = CFDictionaryCreateMutable(NULL, 64, NULL, NULL);
  GBPerfFrameMs = [NSMutableArray arrayWithCapacity:(NSUInteger)(seconds * 125)];
  GBPerfHitches = 0;
  GBPerfHitchMs = GBPerfExpectedMsSum = 0;
  GBPerfLastTimestamp = GBPerfLastTarget = GBPerfStartTime = 0;
  GBPerfDuration = seconds;
  GBPerfLayoutHooksDisabled = hooksOff;
  GBPerfActive = YES;
  GBPerfLink = [CADisplayLink displayLinkWithTarget:GBPerfTicker.shared selector:@selector(tick:)];
  NSInteger maxFps = UIScreen.mainScreen.maximumFramesPerSecond;
  if (@available(iOS 15.0, *))
    GBPerfLink.preferredFrameRateRange = CAFrameRateRangeMake(MIN(60, maxFps), maxFps, maxFps);
  [GBPerfLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

static void GBPerfPrompt(BOOL hooksOff, BOOL chooseMode, NSTimeInterval seconds) {
  if (GBPerfActive || GBPerfPrompting) return;
  GBPerfPrompting = YES;
  NSString *message = [NSString stringWithFormat:
      GBL(@"点「开始」后 1 秒开始记录 %.0f 秒。请保持在首页，持续上下快速滑动 Bot 列表，直到弹出结果。",
          @"Recording starts 1 s after Start and lasts %.0f s. Stay on the home screen and keep scrolling the Bot list until the result appears."), seconds];
  void (^beginScenario)(BOOL, NSString *, NSTimeInterval) = ^(BOOL off, NSString *scenario, NSTimeInterval duration) {
    GBPerfPrompting = NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      GBPerfStart(off, duration, scenario);
    });
  };
  void (^begin)(BOOL) = ^(BOOL off) { beginScenario(off, @"scroll", seconds); };
  NSMutableArray<UIAlertAction *> *actions = [NSMutableArray array];
  if (chooseMode) {
    [actions addObject:[UIAlertAction actionWithTitle:GBL(@"开始（插件布局回调：开）", @"Start (layout hooks ON)")
                                                style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { begin(NO); }]];
    [actions addObject:[UIAlertAction actionWithTitle:GBL(@"开始（插件布局回调：关）", @"Start (layout hooks OFF)")
                                                style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { begin(YES); }]];
    [actions addObject:[UIAlertAction actionWithTitle:GBL(@"静止 8 秒（不要碰屏幕）", @"Idle 8 s (do not touch)")
                                                style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { beginScenario(NO, @"idle", 8); }]];
  } else {
    [actions addObject:[UIAlertAction actionWithTitle:GBL(@"开始", @"Start")
                                                style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { begin(hooksOff); }]];
  }
  [actions addObject:[UIAlertAction actionWithTitle:GBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) {
    GBPerfPrompting = NO;
  }]];
  NSString *title = chooseMode ? GBL(@"滑动性能记录", @"Scroll performance recording")
      : (hooksOff ? GBL(@"滑动性能记录（插件布局回调：关）", @"Scroll recording (layout hooks OFF)")
                  : GBL(@"滑动性能记录（插件布局回调：开）", @"Scroll recording (layout hooks ON)"));
  if (!GBPerfPresent(title, message, actions))
    GBPerfPrompting = NO;
}

BOOL GBPerfHandleURL(NSURL *url) {
  if (![url.scheme.lowercaseString isEqualToString:@"grokbot-local"] ||
      ![url.host.lowercaseString isEqualToString:@"perf"])
    return NO;
  if (!GBDiagnosticsEnabled())
    return YES;
  NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  NSString *hooks = @"";
  NSTimeInterval seconds = 15;
  for (NSURLQueryItem *item in components.queryItems) {
    if ([item.name isEqualToString:@"hooks"]) hooks = item.value.lowercaseString ?: @"";
    if ([item.name isEqualToString:@"seconds"]) {
      double parsed = item.value.doubleValue;
      if (isfinite(parsed) && parsed > 0)
        seconds = MIN(60.0, MAX(5.0, parsed));
    }
  }
  if (!isfinite(seconds) || seconds < 5.0 || seconds > 60.0) seconds = 15.0;
  // External URLs may select hooks=on or open the interactive prompt, never
  // pre-select hooks=off (which suppresses Host layout overlays).
  BOOL chooseMode = ![hooks isEqualToString:@"on"];
  dispatch_async(dispatch_get_main_queue(), ^{ GBPerfPrompt(NO, chooseMode, seconds); });
  return YES;
}
