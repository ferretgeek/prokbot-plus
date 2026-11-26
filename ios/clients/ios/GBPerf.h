#import <Foundation/Foundation.h>
#import <stdint.h>

// Opt-in scroll performance recorder (no third-party SDK). It stays inactive
// unless local diagnostics are enabled (GBDiagnosticsEnabled()) and started
// via `grokbot-local://perf/start?hooks=on&seconds=15` (or
// `grokbot-local://perf/prompt`), then measures frame pacing with CADisplayLink
// and the time the injection library spends in React Native layout hooks.
// Fabric probes are installed on start and restored on finish. Main thread only;
// installs no window gesture recognizers.
extern BOOL GBPerfActive;
// While a "hooks=off" session runs, the RN layout hook skips all plugin work so
// the same build can compare patched vs. un-hooked layout cost on one device.
extern BOOL GBPerfLayoutHooksDisabled;

uint64_t GBPerfNow(void);
void GBPerfRecordLayout(uint64_t originalTicks, uint64_t hookTicks, BOOL entry);
void GBPerfRecordLayoutClass(Class cls);
void GBPerfRecordLabelRead(uint64_t ticks);
BOOL GBPerfHandleURL(NSURL *url);
