// Automatic idle Fork desktop parking and memory-pressure eviction for the shared Linux Box.
// Bridges the host-d0a4baa runtime to the official box-9d2ac1b `/usr/local/bin/stop-window --park`
// contract and `/tmp/sand-window-used.d` activity markers so idle per-agent Fork desktops and
// their Chrome processes release RAM/CPU while keeping seat ownership and browser profiles intact.

const MINUTE_MS = 60_000;

export const IDLE_DESKTOP_PARK_INTERVAL_MS = 60_000;
export const MIN_DESKTOP_PARK_INTERVAL_MS = 10_000;
export const WINDOW_COMMAND_TIMEOUT_SECONDS = 150;
export const UNPARKED_BACKOFF_BASE_MS = 5 * MINUTE_MS;
export const UNPARKED_BACKOFF_MAX_MS = 60 * MINUTE_MS;
export const UNSUPPORTED_PARK_PAUSE_MS = 60 * MINUTE_MS;
export const WAKE_GAP_INTERVALS = 3;

export const DEFAULT_DESKTOP_PARK_CONFIG = Object.freeze({
  enabled: false,
  idleMinutes: 30,
  pressureIdleMinutes: 5,
  pressureAvailablePercent: 15,
  pressurePsiSomeAvg10: 10,
  maxParksPerTick: 5,
  desktopEstimateKb: 400 * 1024,
});

export const SAND_BOX_FIRST_FORK_WINDOW = 2;
export const SAND_BOX_WINDOW_LOCK_DIR = '/tmp/sand-window-locks.d';
export const SAND_BOX_WINDOW_TOKEN_DIR = '/tmp/sand-window-tokens.d';
export const SAND_BOX_WINDOW_USED_DIR = '/tmp/sand-window-used.d';
export const SAND_BOX_MONITOR_BUSY_MARKER_PREFIX = '/tmp/sand-monitor-busy-';
export const SAND_BOX_WINDOW_IN_FLIGHT_SUFFIX = '.inflight';
export const SAND_BOX_FORK_EXEC_PORT_BASE = 14000;
export const SAND_BOX_FORK_VNC_PORT_BASE = 5900;

export const SAND_BOX_WINDOW_PARK_UNSUPPORTED_EXIT_CODE = 74;
export const SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE = 75;
export const SAND_BOX_WINDOW_LOCK_BUSY_EXIT_CODE = 77;
export const SAND_BOX_WINDOW_IN_USE_EXIT_CODE = 78;
export const SAND_BOX_WINDOW_NOT_RUNNING_EXIT_CODE = 79;

const WINDOW_LOCK_WAIT_SECONDS = 70;
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const PARK_OUTCOME_BY_EXIT_CODE = new Map([
  [0, 'parked'],
  [SAND_BOX_WINDOW_IN_USE_EXIT_CODE, 'in-use'],
  [SAND_BOX_WINDOW_LOCK_BUSY_EXIT_CODE, 'in-use'],
  [SAND_BOX_WINDOW_NOT_RUNNING_EXIT_CODE, 'not-running'],
  [SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE, 'not-owner'],
  [SAND_BOX_WINDOW_PARK_UNSUPPORTED_EXIT_CODE, 'unsupported'],
]);

export class SandBoxParkWindowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SandBoxParkWindowError';
    this.code = code;
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function wrapTimedShellCommand(innerCommand) {
  return `timeout -k 5 ${WINDOW_COMMAND_TIMEOUT_SECONDS} /bin/sh -c ${shellSingleQuote(innerCommand)}`;
}

function envBool(raw, fallback) {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  return fallback;
}

function envPositiveNumber(
  raw,
  fallback,
  { allowZero = false, integer = true, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {},
) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  if (integer && !Number.isInteger(parsed)) return fallback;
  if (allowZero ? parsed < 0 : parsed <= 0) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

export function readDesktopParkConfig(env = process.env) {
  return {
    enabled: envBool(env?.GROKBOT_DESKTOP_PARK_ENABLED, DEFAULT_DESKTOP_PARK_CONFIG.enabled),
    idleMinutes: envPositiveNumber(env?.GROKBOT_DESKTOP_PARK_IDLE_MINUTES, DEFAULT_DESKTOP_PARK_CONFIG.idleMinutes),
    pressureIdleMinutes: envPositiveNumber(
      env?.GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES,
      DEFAULT_DESKTOP_PARK_CONFIG.pressureIdleMinutes,
    ),
    pressureAvailablePercent: envPositiveNumber(
      env?.GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT,
      DEFAULT_DESKTOP_PARK_CONFIG.pressureAvailablePercent,
      { allowZero: true, integer: false, max: 100 },
    ),
    pressurePsiSomeAvg10: envPositiveNumber(
      env?.GROKBOT_DESKTOP_PARK_PRESSURE_PSI,
      DEFAULT_DESKTOP_PARK_CONFIG.pressurePsiSomeAvg10,
      { allowZero: true, integer: false },
    ),
    maxParksPerTick: envPositiveNumber(
      env?.GROKBOT_DESKTOP_PARK_MAX_PER_TICK,
      DEFAULT_DESKTOP_PARK_CONFIG.maxParksPerTick,
      { allowZero: true },
    ),
    desktopEstimateKb: DEFAULT_DESKTOP_PARK_CONFIG.desktopEstimateKb,
  };
}

export function readDesktopParkIntervalMs(env = process.env) {
  return envPositiveNumber(env?.GROKBOT_DESKTOP_PARK_INTERVAL_MS, IDLE_DESKTOP_PARK_INTERVAL_MS, {
    min: MIN_DESKTOP_PARK_INTERVAL_MS,
  });
}

export function isUnderMemoryPressure(memory, config = DEFAULT_DESKTOP_PARK_CONFIG) {
  if (memory === undefined || memory === null) return false;
  if (Number.isFinite(memory.totalKb) && memory.totalKb > 0 && Number.isFinite(memory.availableKb)) {
    const availablePercent = (memory.availableKb / memory.totalKb) * 100;
    if (availablePercent < config.pressureAvailablePercent) return true;
  }
  return memory.psiSomeAvg10 !== undefined && Number.isFinite(memory.psiSomeAvg10) &&
    memory.psiSomeAvg10 > config.pressurePsiSomeAvg10;
}

export function parksToRelievePressure(memory, config = DEFAULT_DESKTOP_PARK_CONFIG) {
  if (memory === undefined || memory === null || !(memory.totalKb > 0)) return 0;
  const targetKb = (memory.totalKb * config.pressureAvailablePercent) / 100;
  const shortfallKb = targetKb - memory.availableKb;
  return Math.max(1, Math.ceil(shortfallKb / config.desktopEstimateKb));
}

export function decideDesktopParks(input) {
  const config = { ...DEFAULT_DESKTOP_PARK_CONFIG, ...input.config };
  const firstForkIndex = input.firstForkWindowIndex ?? SAND_BOX_FIRST_FORK_WINDOW;
  const underPressure = isUnderMemoryPressure(input.memory, config);
  const candidates = input.seats
    .filter(
      seat =>
        Number.isInteger(seat.windowIndex) &&
        seat.windowIndex >= firstForkIndex &&
        seat.running === true &&
        !seat.viewerAttached &&
        !input.liveAgentIds.has(seat.agentId),
    )
    .map(seat => ({
      seat,
      ttlIdleMs: input.nowMs - Math.max(seat.lastUsedAtMs ?? Number.NEGATIVE_INFINITY, input.idleClockStartMs),
      sinceUseMs: input.nowMs - (seat.lastUsedAtMs ?? input.idleClockStartMs),
    }));

  const byWindow = (left, right) => left.seat.windowIndex - right.seat.windowIndex;
  const idleThresholdMs = config.idleMinutes * MINUTE_MS;
  const pressureThresholdMs = config.pressureIdleMinutes * MINUTE_MS;
  const parks = [];

  const idleOrdered = [...candidates].sort((left, right) => right.ttlIdleMs - left.ttlIdleMs || byWindow(left, right));
  for (const { seat, ttlIdleMs } of idleOrdered) {
    if (ttlIdleMs < idleThresholdMs) continue;
    parks.push({
      agentId: seat.agentId,
      windowIndex: seat.windowIndex,
      reason: 'idle',
      idleMs: ttlIdleMs,
      minIdleSeconds: Math.round(config.idleMinutes * 60),
    });
  }

  if (underPressure) {
    const wanted = parksToRelievePressure(input.memory, config);
    const alreadyQueued = new Set(parks.map(entry => entry.windowIndex));
    const leastRecent = [...candidates].sort(
      (left, right) => right.sinceUseMs - left.sinceUseMs || byWindow(left, right),
    );
    for (const { seat, sinceUseMs } of leastRecent) {
      if (parks.length >= wanted) break;
      if (sinceUseMs < pressureThresholdMs || alreadyQueued.has(seat.windowIndex)) continue;
      parks.push({
        agentId: seat.agentId,
        windowIndex: seat.windowIndex,
        reason: 'pressure',
        idleMs: sinceUseMs,
        minIdleSeconds: Math.round(config.pressureIdleMinutes * 60),
      });
    }
  }

  return {
    underPressure,
    parks: parks.slice(0, Math.max(0, config.maxParksPerTick)),
  };
}

function assertValidForkWindowIndex(windowIndex, label) {
  if (!Number.isInteger(windowIndex) || windowIndex < SAND_BOX_FIRST_FORK_WINDOW || windowIndex > 1000) {
    throw new SandBoxParkWindowError(`Invalid fork window index for ${label}: ${String(windowIndex)}`, 'invalid-window');
  }
}

function assertValidOwnerToken(ownerToken, label) {
  if (typeof ownerToken !== 'string' || !OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new SandBoxParkWindowError(`Refusing to run ${label} with a malformed owner token`, 'malformed-owner-token');
  }
}

export function ensuredMarkerPath(windowIndex) {
  return `${SAND_BOX_WINDOW_LOCK_DIR}/${windowIndex}.ensured`;
}

export function lockedStartWindowCommand(windowIndex, ownerToken) {
  assertValidForkWindowIndex(windowIndex, 'start-window');
  if (ownerToken !== undefined) assertValidOwnerToken(ownerToken, 'start-window');
  const script = ownerToken !== undefined
    ? `setpriv --pdeathsig KILL /usr/local/bin/start-window ${windowIndex} '${ownerToken}'`
    : `setpriv --pdeathsig KILL /usr/local/bin/start-window ${windowIndex}`;
  return wrapTimedShellCommand(
    `mkdir -p ${SAND_BOX_WINDOW_LOCK_DIR} && ` +
    `exec 9>>${SAND_BOX_WINDOW_LOCK_DIR}/${windowIndex} && ` +
    `flock -w ${WINDOW_LOCK_WAIT_SECONDS} 9 || exit ${SAND_BOX_WINDOW_LOCK_BUSY_EXIT_CODE}; ` +
    `${script} 9>&-; sx=$?; ` +
    `if [ "$sx" -eq 0 ]; then touch ${ensuredMarkerPath(windowIndex)} 2>/dev/null || true; fi; ` +
    `exit "$sx"`,
  );
}

export function lockedStopWindowCommand(windowIndex) {
  assertValidForkWindowIndex(windowIndex, 'stop-window');
  return wrapTimedShellCommand(
    `mkdir -p ${SAND_BOX_WINDOW_LOCK_DIR} && ` +
    `exec 9>>${SAND_BOX_WINDOW_LOCK_DIR}/${windowIndex} && ` +
    `flock -w ${WINDOW_LOCK_WAIT_SECONDS} 9 || exit ${SAND_BOX_WINDOW_LOCK_BUSY_EXIT_CODE}; ` +
    `rm -f ${ensuredMarkerPath(windowIndex)} 2>/dev/null || true; ` +
    `setpriv --pdeathsig KILL /usr/local/bin/stop-window ${windowIndex} 9>&-; sx=$?; ` +
    `exit "$sx"`,
  );
}

export function parkWindowCommand(windowIndex, ownerToken, { idleSeconds }) {
  assertValidForkWindowIndex(windowIndex, 'park-window');
  assertValidOwnerToken(ownerToken, 'park-window');
  if (!Number.isInteger(idleSeconds) || idleSeconds < 0) {
    throw new SandBoxParkWindowError('Refusing to park a window with a malformed idle threshold', 'malformed-idle-threshold');
  }
  const daemonPort = SAND_BOX_FORK_EXEC_PORT_BASE + windowIndex;
  const vncPort = SAND_BOX_FORK_VNC_PORT_BASE + windowIndex;
  const markers = `${SAND_BOX_MONITOR_BUSY_MARKER_PREFIX}${windowIndex} ${SAND_BOX_WINDOW_USED_DIR}/${windowIndex} ${ensuredMarkerPath(windowIndex)}`;
  const inFlight = `${SAND_BOX_WINDOW_USED_DIR}/${windowIndex}${SAND_BOX_WINDOW_IN_FLIGHT_SUFFIX}`;
  return wrapTimedShellCommand(
    `grep -qF -- --park /usr/local/bin/stop-window 2>/dev/null || exit ${SAND_BOX_WINDOW_PARK_UNSUPPORTED_EXIT_CODE}; ` +
    `mkdir -p ${SAND_BOX_WINDOW_LOCK_DIR} && ` +
    `exec 9>>${SAND_BOX_WINDOW_LOCK_DIR}/${windowIndex} && ` +
    `flock -n 9 || exit ${SAND_BOX_WINDOW_LOCK_BUSY_EXIT_CODE}; ` +
    `t="$(cat ${SAND_BOX_WINDOW_TOKEN_DIR}/${windowIndex} 2>/dev/null)"; ` +
    `if [ "$t" != '${ownerToken}' ]; then exit ${SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE}; fi; ` +
    `if ! { xdpyinfo -display :${windowIndex} >/dev/null 2>&1 || ss -ltnH "sport = :${daemonPort}" 2>/dev/null | grep -q .; }; then exit ${SAND_BOX_WINDOW_NOT_RUNNING_EXIT_CODE}; fi; ` +
    `if { now="$(date +%s)"; recent=no; [ -e ${inFlight} ] && recent=yes; ` +
    `for f in ${markers}; do m="$(stat -c %Y "$f" 2>/dev/null)" || continue; [ $((now - m)) -lt ${idleSeconds} ] && recent=yes; done; ` +
    `[ "$recent" = yes ]; }; then exit ${SAND_BOX_WINDOW_IN_USE_EXIT_CODE}; fi; ` +
    `if ss -tnH state established "( sport = :${vncPort} )" 2>/dev/null | grep -q .; then exit ${SAND_BOX_WINDOW_IN_USE_EXIT_CODE}; fi; ` +
    `xp="$(tr -dc 0-9 2>/dev/null < /tmp/.X${windowIndex}-lock)"; ` +
    `setpriv --pdeathsig KILL /usr/local/bin/stop-window --park ${windowIndex} 9>&-; sx=$?; ` +
    `if [ -n "$xp" ]; then for _ in $(seq 1 50); do kill -0 "$xp" 2>/dev/null || break; sleep 0.1; done; fi; ` +
    `exit "$sx"`,
  );
}

export function desktopActivityCommand(windowIndexes) {
  const forks = windowIndexes.filter(
    windowIndex => Number.isInteger(windowIndex) && windowIndex >= SAND_BOX_FIRST_FORK_WINDOW && windowIndex <= 1000,
  );
  const windows = forks.join(' ');
  return wrapTimedShellCommand(
    `echo "now $(date +%s)"; ` +
    `awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if (t>0) print "mem", t+0, a+0}' /proc/meminfo 2>/dev/null; ` +
    `awk '/^some /{for(i=2;i<=NF;i++) if ($i ~ /^avg10=/) {sub(/^avg10=/, "", $i); print "psi", $i}}' /proc/pressure/memory 2>/dev/null; ` +
    `est="$(ss -tnH state established 2>/dev/null | awk '{print $3}')"; ` +
    `lst="$(ss -ltnH 2>/dev/null | awk '{print $4}')"; ` +
    (windows.length === 0
      ? ''
      : `for n in ${windows}; do ` +
        `r=0; { [ -S /tmp/.X11-unix/X$n ] || printf '%s\\n' "$lst" | grep -q ":$((${SAND_BOX_FORK_EXEC_PORT_BASE} + n))$"; } && r=1; ` +
        `b="$(stat -c %Y ${SAND_BOX_MONITOR_BUSY_MARKER_PREFIX}$n 2>/dev/null || echo 0)"; ` +
        `u="$(stat -c %Y ${SAND_BOX_WINDOW_USED_DIR}/$n 2>/dev/null || echo 0)"; ` +
        `e="$(stat -c %Y ${SAND_BOX_WINDOW_LOCK_DIR}/$n.ensured 2>/dev/null || echo 0)"; ` +
        `[ "$e" -gt "$u" ] && u="$e"; ` +
        `[ -e ${SAND_BOX_WINDOW_USED_DIR}/$n${SAND_BOX_WINDOW_IN_FLIGHT_SUFFIX} ] && u="$(date +%s)"; ` +
        `v=0; printf '%s\\n' "$est" | grep -q ":$((${SAND_BOX_FORK_VNC_PORT_BASE} + n))$" && v=1; ` +
        `echo "w $n $r $b $u $v"; ` +
        `done`),
  );
}

function parseEpochSeconds(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return seconds > 0 ? seconds * 1000 : undefined;
}

export function parseDesktopActivity(stdout, windowIndexes) {
  let nowMs;
  let memory;
  let psiSomeAvg10;
  const allowed = new Set(windowIndexes);
  const byWindow = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [kind, ...fields] = trimmed.split(/\s+/);
    if (kind === 'now') {
      nowMs = parseEpochSeconds(fields[0]);
    } else if (kind === 'mem') {
      const totalKb = Number.parseInt(fields[0] ?? '', 10);
      const availableKb = Number.parseInt(fields[1] ?? '', 10);
      if (Number.isInteger(totalKb) && totalKb > 0 && Number.isInteger(availableKb) && availableKb >= 0) {
        memory = { totalKb, availableKb, psiSomeAvg10: undefined };
      }
    } else if (kind === 'psi') {
      const value = Number.parseFloat(fields[0] ?? '');
      if (Number.isFinite(value) && value >= 0) psiSomeAvg10 = value;
    } else if (kind === 'w' && fields.length === 5) {
      const windowIndex = Number.parseInt(fields[0] ?? '', 10);
      if (!allowed.has(windowIndex)) continue;
      const usedStamps = [parseEpochSeconds(fields[2]), parseEpochSeconds(fields[3])].filter(at => at !== undefined);
      byWindow.set(windowIndex, {
        windowIndex,
        running: fields[1] === '1',
        lastUsedAtMs: usedStamps.length === 0 ? undefined : Math.max(...usedStamps),
        viewerAttached: fields[4] === '1',
      });
    }
  }
  if (nowMs === undefined) return undefined;
  return {
    nowMs,
    memory: memory === undefined ? undefined : { ...memory, psiSomeAvg10 },
    windows: windowIndexes.flatMap(windowIndex => {
      const activity = byWindow.get(windowIndex);
      return activity === undefined ? [] : [activity];
    }),
  };
}

function extractShellExit(result) {
  const shell = result?.result;
  if (!shell) return undefined;
  if (shell.case === 'success' && shell.value && typeof shell.value.exitCode === 'number') {
    return shell.value;
  }
  if (shell.case === 'failure' && !shell.value?.aborted && typeof shell.value?.exitCode === 'number') {
    return shell.value;
  }
  return undefined;
}

function seatKey(seat) {
  return `${seat.agentId}:${seat.windowIndex}`;
}

export function unparkedBackoffMs(attempts) {
  return Math.min(UNPARKED_BACKOFF_MAX_MS, UNPARKED_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function createIdleDesktopPark(deps) {
  const clock = deps.clock ?? { monotonicNow: () => performance.now() };
  const intervalMs = deps.intervalMs ?? IDLE_DESKTOP_PARK_INTERVAL_MS;
  let idleClockStartMs;
  let lastReading;
  let unsupportedSince;
  let timer = null;
  let tickInFlight = false;
  let rosterPendingTicks = 0;
  const unparked = new Map();

  const backingOff = (key, now) => {
    const entry = unparked.get(key);
    return entry !== undefined && now - entry.since < unparkedBackoffMs(entry.attempts);
  };

  const tick = async () => {
    const config = deps.readConfig();
    if (!config.enabled) {
      idleClockStartMs = undefined;
      lastReading = undefined;
      unsupportedSince = undefined;
      rosterPendingTicks = 0;
      unparked.clear();
      return { kind: 'disabled' };
    }
    const liveAgentIds = deps.liveAgentIds();
    if (liveAgentIds === undefined) {
      rosterPendingTicks += 1;
      if (rosterPendingTicks === 3 || (rosterPendingTicks > 3 && rosterPendingTicks % 10 === 0)) {
        deps.log?.(`idle desktop park waiting for transcript roster (ticks=${rosterPendingTicks})`);
      }
      return { kind: 'roster-pending' };
    }
    rosterPendingTicks = 0;
    const monoNow = clock.monotonicNow();
    if (unsupportedSince !== undefined && monoNow - unsupportedSince < UNSUPPORTED_PARK_PAUSE_MS) {
      return { kind: 'unsupported' };
    }
    unsupportedSince = undefined;

    const snapshot = await deps.desktops.snapshotForkDesktops(deps.ctx);
    if (snapshot === undefined) return { kind: 'unsupported' };

    const reading = { boxMs: snapshot.nowMs, monotonic: clock.monotonicNow() };
    const boxClockJumpMs = lastReading === undefined
      ? 0
      : reading.boxMs - lastReading.boxMs - (reading.monotonic - lastReading.monotonic);
    if (idleClockStartMs === undefined || boxClockJumpMs > intervalMs * WAKE_GAP_INTERVALS) {
      idleClockStartMs = snapshot.nowMs;
    }
    lastReading = reading;

    const currentSeatKeys = new Set(snapshot.seats.map(seatKey));
    for (const key of unparked.keys()) {
      if (!currentSeatKeys.has(key)) unparked.delete(key);
    }

    const plan = decideDesktopParks({
      nowMs: snapshot.nowMs,
      idleClockStartMs,
      seats: snapshot.seats.filter(seat => !backingOff(seatKey(seat), reading.monotonic)),
      liveAgentIds,
      memory: snapshot.memory,
      config,
    });

    const results = [];
    for (const park of plan.parks) {
      let outcome;
      try {
        outcome = await deps.desktops.parkAgentWindow(deps.ctx, park.agentId, {
          minIdleSeconds: park.minIdleSeconds,
        });
      } catch (error) {
        deps.log?.(`idle desktop park on :${park.windowIndex} failed: ${error?.message ?? String(error)}`);
        outcome = 'failed';
      }
      results.push({ ...park, outcome });
      deps.log?.(
        `idle desktop park: :${park.windowIndex} reason=${park.reason} idleMinutes=${Math.floor(park.idleMs / MINUTE_MS)} outcome=${outcome}`,
      );
      const key = seatKey(park);
      if (outcome === 'unsupported') {
        unsupportedSince = clock.monotonicNow();
        break;
      }
      if (outcome === 'parked') {
        unparked.delete(key);
      } else {
        unparked.set(key, {
          attempts: (unparked.get(key)?.attempts ?? 0) + 1,
          since: clock.monotonicNow(),
        });
      }
    }

    return {
      kind: 'ticked',
      underPressure: plan.underPressure,
      running: snapshot.seats.filter(seat => seat.running).length,
      results,
    };
  };

  const runTickSafely = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tick();
    } catch (error) {
      deps.log?.(`idle desktop park tick failed: ${error?.message ?? String(error)}`);
    } finally {
      tickInFlight = false;
    }
  };

  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runTickSafely();
      }, intervalMs);
      timer.unref?.();
    },
    dispose() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      deps.onDispose?.();
    },
  };
}

function abortErrorFromSignal(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'Aborted');
  err.name = 'AbortError';
  return err;
}

async function untilCanceled(promise, signal) {
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) {
    throw abortErrorFromSignal(signal);
  }
  let onAbort;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(abortErrorFromSignal(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createComputerParkOverrides(original, log = () => {}) {
  const {
    SAND_BOX_FIRST_FORK_WINDOW_INDEX = SAND_BOX_FIRST_FORK_WINDOW,
    SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE: origUnavailableCode = SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE,
    SandBoxNoMonitorAvailableError,
    isPrimaryWindowIndex,
    reportHostDiagnostic,
    shellExecutorResource,
  } = original ?? {};

  const missing = [];
  if (typeof isPrimaryWindowIndex !== 'function') missing.push('isPrimaryWindowIndex');
  if (SandBoxNoMonitorAvailableError === undefined) missing.push('SandBoxNoMonitorAvailableError');
  if (shellExecutorResource === undefined) missing.push('shellExecutorResource');
  if (missing.length > 0) {
    log(`idle desktop park overrides disabled: missing original computer dependencies (${missing.join(', ')})`);
    return {};
  }

  return {
    runStartWindow: (_origRunStartWindow, bindings) => async function lockedRunStartWindow(ctx, accessor, windowIndex, ownerToken) {
      if (isPrimaryWindowIndex(windowIndex)) {
        reportHostDiagnostic?.({ kind: 'window_guard_refused', stage: 'start-window' });
        return;
      }
      const { buildHostShellArgs, SandBoxWindowError } = bindings;
      if (typeof buildHostShellArgs !== 'function' || SandBoxWindowError === undefined) {
        throw new Error('Missing Computer/Box runtime bindings for start-window');
      }
      if (ownerToken !== undefined && !OWNER_TOKEN_PATTERN.test(ownerToken)) {
        throw new SandBoxWindowError('refusing to run start-window with a malformed owner token');
      }
      const result = await accessor.get(shellExecutorResource).execute(
        ctx,
        buildHostShellArgs({
          command: lockedStartWindowCommand(windowIndex, ownerToken),
          name: 'start-window',
          workingDirectory: '/workspace',
          toolCallId: 'sand-start-window',
        }),
      );
      const exited = extractShellExit(result);
      if (!exited) {
        throw new SandBoxWindowError(`start-window failed (${result?.result?.case ?? 'unknown'})`);
      }
      if (exited.exitCode === origUnavailableCode) {
        throw new SandBoxNoMonitorAvailableError(
          `start-window could not claim display :${windowIndex}: it is a live fork owned by a different agent`,
        );
      }
      if (exited.exitCode !== 0) {
        throw new SandBoxWindowError(`start-window exited ${exited.exitCode}: ${exited.stderr ?? ''}`);
      }
    },

    runStopWindow: (_origRunStopWindow, bindings) => async function lockedRunStopWindow(ctx, accessor, windowIndex) {
      if (isPrimaryWindowIndex(windowIndex)) {
        reportHostDiagnostic?.({ kind: 'window_guard_refused', stage: 'stop-window' });
        return;
      }
      const { buildHostShellArgs, SandBoxWindowError } = bindings;
      if (typeof buildHostShellArgs !== 'function' || SandBoxWindowError === undefined) {
        throw new Error('Missing Computer/Box runtime bindings for stop-window');
      }
      const result = await accessor.get(shellExecutorResource).execute(
        ctx,
        buildHostShellArgs({
          command: lockedStopWindowCommand(windowIndex),
          name: 'stop-window',
          workingDirectory: '/workspace',
          toolCallId: 'sand-stop-window',
        }),
      );
      const exited = extractShellExit(result);
      if (!exited) {
        throw new SandBoxWindowError(`stop-window failed (${result?.result?.case ?? 'unknown'})`);
      }
      if (exited.exitCode !== 0) {
        throw new SandBoxWindowError(`stop-window exited ${exited.exitCode}: ${exited.stderr ?? ''}`);
      }
    },

    LoopbackSandBox: (BaseLoopbackSandBox, bindings) => {
      BaseLoopbackSandBox.prototype.readDesktopActivity = async function readDesktopActivity(ctx, agentId, windowIndexes) {
        const { buildHostShellArgs, SandBoxWindowError } = bindings;
        if (typeof buildHostShellArgs !== 'function' || SandBoxWindowError === undefined) {
          throw new Error('Missing Computer/Box runtime bindings for readDesktopActivity');
        }
        const forks = windowIndexes.filter(
          windowIndex => Number.isInteger(windowIndex) && !isPrimaryWindowIndex(windowIndex),
        );
        const primary = await this.ensureReady(ctx, agentId);
        const result = await primary.remoteAccessor.get(shellExecutorResource).execute(
          ctx,
          buildHostShellArgs({
            command: desktopActivityCommand(forks),
            name: 'desktop-activity',
            workingDirectory: '/workspace',
            toolCallId: 'sand-desktop-activity',
          }),
        );
        const exited = extractShellExit(result);
        if (!exited || exited.exitCode !== 0) {
          throw new SandBoxWindowError(`desktop-activity failed (${result?.result?.case ?? 'unknown'})`);
        }
        const snapshot = parseDesktopActivity(exited.stdout, forks);
        if (snapshot === undefined) {
          throw new SandBoxWindowError('desktop-activity printed no box clock');
        }
        return snapshot;
      };

      BaseLoopbackSandBox.prototype.parkWindow = async function parkWindow(ctx, agentId, windowIndex, opts) {
        const { buildHostShellArgs, sandBoxWindowKey } = bindings;
        if (typeof buildHostShellArgs !== 'function' || typeof sandBoxWindowKey !== 'function') {
          throw new SandBoxParkWindowError('Missing Computer/Box runtime bindings for parkWindow', 'missing-bindings');
        }
        if (windowIndex == null || isPrimaryWindowIndex(windowIndex)) return 'not-running';
        const primary = await this.ensureReady(ctx, agentId);
        const result = await primary.remoteAccessor.get(shellExecutorResource).execute(
          ctx,
          buildHostShellArgs({
            command: parkWindowCommand(windowIndex, opts.ownerToken, { idleSeconds: opts.idleSeconds }),
            name: 'park-window',
            workingDirectory: '/workspace',
            toolCallId: 'sand-park-window',
          }),
        );
        const exited = extractShellExit(result);
        if (!exited) {
          throw new SandBoxParkWindowError(
            `park-window failed (${result?.result?.case ?? 'unknown'})`,
            `result-${result?.result?.case ?? 'unknown'}`,
          );
        }
        const outcome = PARK_OUTCOME_BY_EXIT_CODE.get(exited.exitCode);
        if (outcome === undefined) {
          throw new SandBoxParkWindowError(
            `park-window exited ${exited.exitCode}: ${exited.stderr ?? ''}`,
            `exit-${exited.exitCode}`,
          );
        }
        if (outcome === 'parked' || outcome === 'not-running' || outcome === 'not-owner') {
          this.windowConnections?.delete?.(sandBoxWindowKey(agentId, windowIndex));
        }
        return outcome;
      };

      return BaseLoopbackSandBox;
    },

    SharedDesktopSandBox: BaseSharedDesktopSandBox => {
      const origEnsureReady = BaseSharedDesktopSandBox.prototype.ensureReady;
      const origReleaseWindow = BaseSharedDesktopSandBox.prototype.releaseWindow;

      BaseSharedDesktopSandBox.prototype.inAgentQueue = function inAgentQueue(agentId, work, ctx) {
        if (ctx?.signal?.aborted) {
          return Promise.reject(abortErrorFromSignal(ctx.signal));
        }
        this._agentParkQueues ??= new Map();
        const previous = this._agentParkQueues.get(agentId) ?? Promise.resolve();
        let releaseTurn;
        const turnDone = new Promise(resolve => {
          releaseTurn = resolve;
        });
        const tail = turnDone.finally(() => {
          if (this._agentParkQueues.get(agentId) === tail) {
            this._agentParkQueues.delete(agentId);
          }
        });
        this._agentParkQueues.set(agentId, tail);

        return (async () => {
          try {
            await untilCanceled(previous.catch(() => {}), ctx?.signal);
            return await work();
          } finally {
            releaseTurn();
          }
        })();
      };

      BaseSharedDesktopSandBox.prototype.ensureReady = function queuedEnsureReady(ctx, agentId) {
        return this.inAgentQueue(agentId, () => origEnsureReady.call(this, ctx, agentId), ctx);
      };

      BaseSharedDesktopSandBox.prototype.releaseWindow = function queuedReleaseWindow(ctx, agentId) {
        return this.inAgentQueue(agentId, () => origReleaseWindow.call(this, ctx, agentId), ctx);
      };

      BaseSharedDesktopSandBox.prototype.startedForkSeats = async function startedForkSeats(ctx) {
        await this.ensureAssignmentsLoaded(ctx);
        const seats = [];
        for (const [agentId, windowIndex] of this.agentWindows) {
          if (windowIndex < SAND_BOX_FIRST_FORK_WINDOW_INDEX) continue;
          const ownerToken = this.agentWindowTokens.get(agentId);
          if (!ownerToken) continue;
          if (!this.establishedForks.has(agentId) && !this.inheritedForks.has(agentId)) continue;
          seats.push({ agentId, windowIndex });
        }
        return seats;
      };

      BaseSharedDesktopSandBox.prototype.snapshotForkDesktops = async function snapshotForkDesktops(ctx) {
        if (typeof this.inner?.readDesktopActivity !== 'function') return undefined;
        const seats = await this.startedForkSeats(ctx);
        const activity = await this.inner.readDesktopActivity(
          ctx,
          this.sharedBoxId,
          seats.map(seat => seat.windowIndex),
        );
        const byWindow = new Map(activity.windows.map(entry => [entry.windowIndex, entry]));
        return {
          nowMs: activity.nowMs,
          memory: activity.memory,
          seats: seats.flatMap(seat => {
            const entry = byWindow.get(seat.windowIndex);
            return entry === undefined ? [] : [{ ...entry, agentId: seat.agentId }];
          }),
        };
      };

      BaseSharedDesktopSandBox.prototype.parkAgentWindow = function parkAgentWindow(ctx, agentId, opts) {
        return this.inAgentQueue(agentId, async () => {
          if (typeof this.inner?.parkWindow !== 'function') return 'unsupported';
          await this.ensureAssignmentsLoaded(ctx);
          const windowIndex = this.agentWindows.get(agentId);
          const ownerToken = this.agentWindowTokens.get(agentId);
          if (windowIndex === undefined || windowIndex < SAND_BOX_FIRST_FORK_WINDOW_INDEX || !ownerToken) {
            return 'no-seat';
          }
          return await this.inner.parkWindow(ctx, this.sharedBoxId, windowIndex, {
            ownerToken,
            idleSeconds: opts.minIdleSeconds,
          });
        }, ctx);
      };

      return BaseSharedDesktopSandBox;
    },
  };
}

export function resolveSharedDesktopBox(box) {
  if (!box || typeof box !== 'object') return undefined;
  if (typeof box.snapshotForkDesktops === 'function' && typeof box.parkAgentWindow === 'function') {
    return box;
  }
  if (box.inner && typeof box.inner === 'object') return resolveSharedDesktopBox(box.inner);
  if (box.box && typeof box.box === 'object') return resolveSharedDesktopBox(box.box);
  return undefined;
}

export function collectLiveAgentIds({ host, transcript, autoReview, session, desktops }) {
  const transcriptApi = typeof transcript === 'function' ? transcript() : (transcript ?? host?.transcript);
  const rawRunning = typeof transcriptApi?.liveRunningAgentIds === 'function'
    ? transcriptApi.liveRunningAgentIds()
    : typeof transcriptApi?.runLifecycle?.runningAgentIds === 'function'
      ? transcriptApi.runLifecycle.runningAgentIds()
      : undefined;
  if (rawRunning == null) return undefined;
  const live = new Set(rawRunning);

  const runners = typeof transcriptApi?.runnerRegistry?.values === 'function'
    ? transcriptApi.runnerRegistry.values()
    : transcriptApi?.runnerRegistry?.runners instanceof Map
      ? transcriptApi.runnerRegistry.runners.values()
      : Array.isArray(transcriptApi?.runnerRegistry?.runners)
        ? transcriptApi.runnerRegistry.runners
        : undefined;
  if (runners) {
    for (const runner of runners) {
      if (typeof runner?.hasRunningBackgroundShellWork === 'function' && runner.hasRunningBackgroundShellWork()) {
        const agentId = runner.agentId ?? runner.session?.agentId ?? runner.getAgentId?.();
        if (typeof agentId === 'string' && agentId) live.add(agentId);
      }
    }
  }

  const approvalAgents = autoReview?.()?.agentIdsWithPendingApprovals?.();
  if (approvalAgents) {
    for (const agentId of approvalAgents) live.add(agentId);
  }
  const sessionApi = typeof session?.()?.pendingHandoff === 'function'
    ? session()
    : typeof host?.session?.pendingHandoff === 'function'
      ? host.session
      : undefined;
  if (sessionApi && desktops?.agentWindows instanceof Map) {
    for (const agentId of desktops.agentWindows.keys()) {
      if (sessionApi.pendingHandoff(agentId) != null) live.add(agentId);
    }
  }
  return live;
}

export function startLocalIdleDesktopPark({
  context,
  host,
  library,
  foreverBox,
  transcript,
  autoReview,
  session,
  env = process.env,
}) {
  const initialConfig = readDesktopParkConfig(env);
  if (!initialConfig.enabled) return null;
  const desktops = resolveSharedDesktopBox(foreverBox?.box);
  if (!desktops || typeof library?.createContext !== 'function') return null;
  const [baseCtx, cancel] = library.createContext().withCancel();
  const ctx = typeof baseCtx.withName === 'function' ? baseCtx.withName('idleDesktopPark') : baseCtx;
  const intervalMs = readDesktopParkIntervalMs(env);
  host?.log?.(
    `idle desktop park enabled: idleMinutes=${initialConfig.idleMinutes} pressureIdleMinutes=${initialConfig.pressureIdleMinutes} ` +
    `pressureAvailablePercent=${initialConfig.pressureAvailablePercent} pressurePsiSomeAvg10=${initialConfig.pressurePsiSomeAvg10} ` +
    `maxParksPerTick=${initialConfig.maxParksPerTick} intervalMs=${intervalMs}`,
  );
  const parker = createIdleDesktopPark({
    ctx,
    desktops,
    readConfig: () => readDesktopParkConfig(env),
    liveAgentIds: () => collectLiveAgentIds({ host, transcript, autoReview, session, desktops }),
    intervalMs,
    log: message => host?.log?.(message),
    onDispose: () => cancel(new Error('idle desktop park stopped')),
  });
  parker.start();
  context?.onStop?.(() => parker.dispose());
  return parker;
}
