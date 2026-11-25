#import <Foundation/Foundation.h>
#import <stdint.h>

// Opt-in scroll performance recorder (no third-party SDK). It stays inactive
// unless started from `grokbot-local://perf/start?hooks=on|off&seconds=15` (or
// `grokbot-local://perf/prompt`), then measures frame pacing with CADisplayLink
// and the time the injection library spends in React Native layout hooks.
// Main thread only; installs no window gesture recognizers.
extern BOOL GBPerfActive;
// While a "hooks=off" session runs, the RN layout hook skips all plugin work so
// the same build can compare patched vs. un-hooked layout cost on one device.
extern BOOL GBPerfLayoutHooksDisabled;

uint64_t GBPerfNow(void);
void GBPerfRecordLayout(uint64_t originalTicks, uint64_t hookTicks, BOOL entry);
void GBPerfRecordLayoutClass(Class cls);
void GBPerfRecordLabelRead(uint64_t ticks);
BOOL GBPerfHandleURL(NSURL *url);
