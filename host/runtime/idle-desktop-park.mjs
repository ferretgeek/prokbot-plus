// Opt-in idle Fork desktop eviction and memory-pressure parking for the shared Linux Box.
// Built from scratch against only the execution container's external filesystem/port/CLI contract:
// - /usr/local/bin/stop-window --park <N> (exits 0)
// - /tmp/sand-window-used.d/<N>, <N>.inflight, /tmp/sand-window-tokens.d/<N>, /tmp/sand-monitor-busy-<N>
// - ports 14000+N (exec-daemon) & 5900+N (x11vnc), /tmp/.X<N>-lock, /proc/meminfo, /proc/pressure/memory

const MS_PER_MINUTE = 60_000;

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const MIN_POLL_INTERVAL_MS = 10_000;
export const SHELL_TIMEOUT_SECONDS = 150;
export const UNSUPPORTED_COOLDOWN_MS = 60 * MS_PER_MINUTE;

export const DEFAULT_PARK_POLICY = Object.freeze({
  enabled: false,
  idleMinutes: 30,
  pressureIdleMinutes: 5,
  pressureAvailablePercent: 15,
  pressurePsiSomeAvg10: 10,
  maxParksPerTick: 5,
});

// External container interface (tokens, activity markers, ports) plus ProkBot Plus's own lock/stamp dir.
export const BOX_CONTRACT = Object.freeze({
  firstForkDisplay: 2,
  maxForkDisplay: 1000,
  execPortBase: 14000,
  vncPortBase: 5900,
  tokenDir: '/tmp/sand-window-tokens.d',
  usedDir: '/tmp/sand-window-used.d',
  busyFilePrefix: '/tmp/sand-monitor-busy-',
  inflightExt: '.inflight',
  parkStateDir: '/tmp/grokbot-park.d',
});

const SEAT_LOCK_WAIT_SECONDS = 45;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const PARK_STATUS_PREFIX = 'GROKBOT_PARK_STATUS=';
const VALID_PARK_OUTCOMES = new Set(['parked', 'busy', 'not-owner', 'not-running', 'failed']);

export class DesktopParkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DesktopParkError';
    this.code = code;
  }
}

function quoteShellArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function wrapCommandWithTimeout(script) {
  return `timeout -k 5 ${SHELL_TIMEOUT_SECONDS} /bin/sh -c ${quoteShellArg(script)}`;
}

function parseBoolEnv(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const val = raw.trim().toLowerCase();
  if (val === '0' || val === 'false' || val === 'no' || val === 'off') return false;
  if (val === '1' || val === 'true' || val === 'yes' || val === 'on') return true;
  return fallback;
}

function parseNumericEnv(raw, fallback, { allowZero = false, integer = true, min = -Infinity, max = Infinity } = {}) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return fallback;
  if (integer && !Number.isInteger(num)) return fallback;
  if (allowZero ? num < 0 : num <= 0) return fallback;
  if (num < min || num > max) return fallback;
  return num;
}

export function readDesktopParkConfig(env = process.env) {
  return {
    enabled: parseBoolEnv(env?.GROKBOT_DESKTOP_PARK_ENABLED, DEFAULT_PARK_POLICY.enabled),
    idleMinutes: parseNumericEnv(env?.GROKBOT_DESKTOP_PARK_IDLE_MINUTES, DEFAULT_PARK_POLICY.idleMinutes),
    pressureIdleMinutes: parseNumericEnv(
      env?.GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES,
      DEFAULT_PARK_POLICY.pressureIdleMinutes,
    ),
    pressureAvailablePercent: parseNumericEnv(
      env?.GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT,
      DEFAULT_PARK_POLICY.pressureAvailablePercent,
      { allowZero: true, integer: false, max: 100 },
    ),
    pressurePsiSomeAvg10: parseNumericEnv(
      env?.GROKBOT_DESKTOP_PARK_PRESSURE_PSI,
      DEFAULT_PARK_POLICY.pressurePsiSomeAvg10,
      { allowZero: true, integer: false },
    ),
    maxParksPerTick: parseNumericEnv(
      env?.GROKBOT_DESKTOP_PARK_MAX_PER_TICK,
      DEFAULT_PARK_POLICY.maxParksPerTick,
      { allowZero: true },
    ),
  };
}

export function readDesktopParkIntervalMs(env = process.env) {
  return parseNumericEnv(env?.GROKBOT_DESKTOP_PARK_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, {
    min: MIN_POLL_INTERVAL_MS,
  });
}

function checkMemoryPressure(memory, policy) {
  if (!memory) return false;
  if (Number.isFinite(memory.totalKb) && memory.totalKb > 0 && Number.isFinite(memory.availableKb)) {
    if ((memory.availableKb / memory.totalKb) * 100 < policy.pressureAvailablePercent) return true;
  }
  return Number.isFinite(memory.psiSomeAvg10) && memory.psiSomeAvg10 > policy.pressurePsiSomeAvg10;
}

/** Select idle or pressure-evictable Fork seats ordered oldest-activity first. */
export function planDesktopEvictions({
  boxTimeMs,
  bootBaselineMs,
  seats,
  activeAgentIds,
  memory,
  config: rawConfig,
}) {
  const policy = { ...DEFAULT_PARK_POLICY, ...rawConfig };
  const underMemoryPressure = checkMemoryPressure(memory, policy);
  const thresholdMinutes = underMemoryPressure ? policy.pressureIdleMinutes : policy.idleMinutes;
  const thresholdMs = thresholdMinutes * MS_PER_MINUTE;
  const cutoffMs = boxTimeMs - thresholdMs;
  const baselineMs = bootBaselineMs ?? boxTimeMs;
  const reason = underMemoryPressure ? 'pressure' : 'idle';
  const minIdleSeconds = Math.round(thresholdMinutes * 60);
  const maxBatch = Math.max(0, policy.maxParksPerTick);

  // Never evict anything before the Host has observed the Box for at least one full idle window.
  if (baselineMs > cutoffMs || maxBatch === 0) {
    return { underMemoryPressure, targets: [] };
  }

  const candidates = [];
  for (const seat of seats ?? []) {
    if (!Number.isInteger(seat?.display) || seat.display < BOX_CONTRACT.firstForkDisplay) continue;
    if (!seat.running || seat.hasViewer || seat.inflight || activeAgentIds?.has(seat.agentId)) continue;
    const lastSeenMs = seat.lastActivityMs ?? 0;
    if (lastSeenMs > cutoffMs) continue;
    const idleMs = Math.max(0, boxTimeMs - Math.max(lastSeenMs, baselineMs));
    candidates.push({
      agentId: seat.agentId,
      display: seat.display,
      reason,
      idleMs,
      minIdleSeconds,
    });
  }

  candidates.sort((a, b) => (b.idleMs - a.idleMs) || (a.display - b.display));
  return {
    underMemoryPressure,
    targets: candidates.slice(0, maxBatch),
  };
}

function validateForkDisplay(display, opName) {
  if (!Number.isInteger(display) || display < BOX_CONTRACT.firstForkDisplay || display > BOX_CONTRACT.maxForkDisplay) {
    throw new DesktopParkError(`Invalid fork display for ${opName}: ${String(display)}`, 'invalid-display');
  }
}

function validateOwnerToken(ownerToken, opName) {
  if (typeof ownerToken !== 'string' || !TOKEN_REGEX.test(ownerToken)) {
    throw new DesktopParkError(`Refusing to run ${opName} with a malformed owner token`, 'malformed-owner-token');
  }
}

export function seatLockPath(display) {
  return `${BOX_CONTRACT.parkStateDir}/seat-${display}.lock`;
}

export function seatWakeStampPath(display) {
  return `${BOX_CONTRACT.parkStateDir}/seat-${display}.woken`;
}

export function buildLockedStartWindowCommand(windowIndex, ownerToken) {
  validateForkDisplay(windowIndex, 'start-window');
  if (ownerToken !== undefined) validateOwnerToken(ownerToken, 'start-window');
  const startCall = ownerToken !== undefined
    ? `setpriv --pdeathsig KILL /usr/local/bin/start-window ${windowIndex} '${ownerToken}'`
    : `setpriv --pdeathsig KILL /usr/local/bin/start-window ${windowIndex}`;
  const lockFile = seatLockPath(windowIndex);
  const wakeStamp = seatWakeStampPath(windowIndex);
  return wrapCommandWithTimeout(
    `mkdir -p ${BOX_CONTRACT.parkStateDir} && ` +
    `exec 9>>${lockFile} && ` +
    `if ! flock -w ${SEAT_LOCK_WAIT_SECONDS} 9; then echo "grokbot-park: lock busy for :${windowIndex}" >&2; exit 1; fi; ` +
    `${startCall} 9>&-; status=$?; ` +
    `if [ "$status" -eq 0 ]; then touch ${wakeStamp} 2>/dev/null || true; fi; ` +
    `exit "$status"`,
  );
}

export function buildLockedStopWindowCommand(windowIndex) {
  validateForkDisplay(windowIndex, 'stop-window');
  const lockFile = seatLockPath(windowIndex);
  const wakeStamp = seatWakeStampPath(windowIndex);
  return wrapCommandWithTimeout(
    `mkdir -p ${BOX_CONTRACT.parkStateDir} && ` +
    `exec 9>>${lockFile} && ` +
    `if ! flock -w ${SEAT_LOCK_WAIT_SECONDS} 9; then echo "grokbot-park: lock busy for :${windowIndex}" >&2; exit 1; fi; ` +
    `rm -f ${wakeStamp} 2>/dev/null || true; ` +
    `setpriv --pdeathsig KILL /usr/local/bin/stop-window ${windowIndex} 9>&-`,
  );
}

/**
 * Build the locked Box shell script that re-verifies idleness and parks a Fork display.
 * Always exits 0 and emits `GROKBOT_PARK_STATUS=<outcome>` on stdout.
 */
export function buildSeatParkCommand(display, ownerToken, idleSeconds) {
  validateForkDisplay(display, 'park-seat');
  validateOwnerToken(ownerToken, 'park-seat');
  if (!Number.isInteger(idleSeconds) || idleSeconds < 0) {
    throw new DesktopParkError('Invalid idle threshold for park-seat', 'malformed-idle-threshold');
  }

  const execPort = BOX_CONTRACT.execPortBase + display;
  const vncPort = BOX_CONTRACT.vncPortBase + display;
  const lockFile = seatLockPath(display);
  const wakeStamp = seatWakeStampPath(display);
  const tokenFile = `${BOX_CONTRACT.tokenDir}/${display}`;
  const usedFile = `${BOX_CONTRACT.usedDir}/${display}`;
  const inflightFile = `${usedFile}${BOX_CONTRACT.inflightExt}`;
  const monitorBusyFile = `${BOX_CONTRACT.busyFilePrefix}${display}`;
  const xSocket = `/tmp/.X11-unix/X${display}`;
  const xLock = `/tmp/.X${display}-lock`;

  const lines = [
    `mkdir -p ${BOX_CONTRACT.parkStateDir}`,
    `exec 9>>${lockFile}`,
    `if ! flock -n 9; then printf "${PARK_STATUS_PREFIX}busy\\n"; exit 0; fi`,
    `token=$(cat ${tokenFile} 2>/dev/null || true)`,
    `if [ "$token" != '${ownerToken}' ]; then printf "${PARK_STATUS_PREFIX}not-owner\\n"; exit 0; fi`,
    `if [ ! -S "${xSocket}" ] && ! ss -ltnH "sport = :${execPort}" 2>/dev/null | grep -q .; then printf "${PARK_STATUS_PREFIX}not-running\\n"; exit 0; fi`,
    `if [ -e "${inflightFile}" ]; then printf "${PARK_STATUS_PREFIX}busy\\n"; exit 0; fi`,
    `if ss -tnH state established "( sport = :${vncPort} )" 2>/dev/null | grep -q .; then printf "${PARK_STATUS_PREFIX}busy\\n"; exit 0; fi`,
    'now_sec=$(date +%s)',
    `for stamp in "${usedFile}" "${monitorBusyFile}" "${wakeStamp}"; do`,
    '  mtime=$(stat -c %Y "$stamp" 2>/dev/null) || continue',
    `  if [ $((now_sec - mtime)) -lt ${idleSeconds} ]; then printf "${PARK_STATUS_PREFIX}busy\\n"; exit 0; fi`,
    'done',
    `if ! setpriv --pdeathsig KILL /usr/local/bin/stop-window --park ${display} 9>&-; then printf "${PARK_STATUS_PREFIX}failed\\n"; exit 0; fi`,
    `rm -f ${wakeStamp} 2>/dev/null || true`,
    // Wait briefly for the X server lock / exec port to finish tearing down before dropping the seat lock.
    'wait_i=0',
    `while [ "$wait_i" -lt 20 ]; do`,
    `  if [ ! -e "${xLock}" ] && ! ss -ltnH "sport = :${execPort}" 2>/dev/null | grep -q .; then break; fi`,
    '  sleep 0.2',
    '  wait_i=$((wait_i + 1))',
    'done',
    `printf "${PARK_STATUS_PREFIX}parked\\n"`,
    'exit 0',
  ];
  return wrapCommandWithTimeout(lines.join('\n'));
}

export function parseSeatParkOutput(stdout) {
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(PARK_STATUS_PREFIX)) continue;
    const status = line.slice(PARK_STATUS_PREFIX.length);
    if (VALID_PARK_OUTCOMES.has(status)) return status;
  }
  return undefined;
}

/**
 * Build a single Box probe command that reports clock, `--park` support, host memory/PSI,
 * and raw per-display signals; Host JS aggregates running/viewer/activity state.
 */
export function buildSeatProbeCommand(displays) {
  const forkDisplays = (Array.isArray(displays) ? displays : []).filter(
    display => Number.isInteger(display) && display >= BOX_CONTRACT.firstForkDisplay && display <= BOX_CONTRACT.maxForkDisplay,
  );
  const lines = [
    'printf "clock\\t%s\\n" "$(date +%s)"',
    'if grep -qF -- --park /usr/local/bin/stop-window 2>/dev/null; then printf "cap\\t1\\n"; else printf "cap\\t0\\n"; fi',
    'awk \'/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t>0) printf "mem\\t%d\\t%d\\n", t, a+0}\' /proc/meminfo 2>/dev/null || true',
    'awk \'/^some /{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub(/^avg10=/,"",$i); printf "psi\\t%s\\n", $i; exit}}\' /proc/pressure/memory 2>/dev/null || true',
  ];
  if (forkDisplays.length > 0) {
    lines.push(
      'l_ports=$(ss -ltnH 2>/dev/null | awk \'{print $4}\')',
      'e_ports=$(ss -tnH state established 2>/dev/null | awk \'{print $3}\')',
      `for d in ${forkDisplays.join(' ')}; do`,
      `  ep=$((${BOX_CONTRACT.execPortBase} + d))`,
      `  vp=$((${BOX_CONTRACT.vncPortBase} + d))`,
      '  x_up=0; [ -S "/tmp/.X11-unix/X$d" ] && x_up=1',
      '  exec_up=0; printf "%s\\n" "$l_ports" | grep -q ":$ep$" && exec_up=1',
      '  vnc_n=$(printf "%s\\n" "$e_ports" | grep -c ":$vp$" || true)',
      `  inf=0; [ -e "${BOX_CONTRACT.usedDir}/$d${BOX_CONTRACT.inflightExt}" ] && inf=1`,
      '  newest=0',
      `  for f in "${BOX_CONTRACT.usedDir}/$d" "${BOX_CONTRACT.busyFilePrefix}$d" "${BOX_CONTRACT.parkStateDir}/seat-$d.woken"; do`,
      '    mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)',
      '    if [ "$mt" -gt "$newest" ] 2>/dev/null; then newest=$mt; fi',
      '  done',
      '  printf "seat\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$d" "$x_up" "$exec_up" "$vnc_n" "$inf" "$newest"',
      'done',
    );
  }
  return wrapCommandWithTimeout(lines.join('\n'));
}

function parseEpochMs(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const sec = Number.parseInt(raw, 10);
  return sec > 0 ? sec * 1000 : undefined;
}

/** Parse tab-delimited output from `buildSeatProbeCommand` and aggregate per-seat state. */
export function parseSeatProbeOutput(stdout, allowedDisplays) {
  let boxTimeMs;
  let supportsPark = true;
  let totalKb;
  let availableKb;
  let psiSomeAvg10;
  const allowed = new Set(allowedDisplays);
  const rawSeats = new Map();

  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split('\t');
    const tag = fields[0];
    if (tag === 'clock' && fields.length === 2) {
      boxTimeMs = parseEpochMs(fields[1]);
    } else if (tag === 'cap' && fields.length === 2) {
      supportsPark = fields[1] !== '0';
    } else if (tag === 'mem' && fields.length === 3) {
      const tot = Number.parseInt(fields[1], 10);
      const avail = Number.parseInt(fields[2], 10);
      if (Number.isInteger(tot) && tot > 0 && Number.isInteger(avail) && avail >= 0) {
        totalKb = tot;
        availableKb = avail;
      }
    } else if (tag === 'psi' && fields.length === 2) {
      const psi = Number.parseFloat(fields[1]);
      if (Number.isFinite(psi) && psi >= 0) psiSomeAvg10 = psi;
    } else if (tag === 'seat' && fields.length === 7) {
      const display = Number.parseInt(fields[1], 10);
      if (!allowed.has(display)) continue;
      const xUp = fields[2] === '1';
      const execUp = fields[3] === '1';
      const vncClients = Number.parseInt(fields[4], 10);
      const inflight = fields[5] === '1';
      const markerMs = parseEpochMs(fields[6]);
      rawSeats.set(display, {
        display,
        running: xUp || execUp,
        hasViewer: Number.isInteger(vncClients) && vncClients > 0,
        inflight,
        markerMs,
      });
    }
  }

  if (boxTimeMs === undefined) return undefined;
  const seats = [];
  for (const display of allowedDisplays) {
    const raw = rawSeats.get(display);
    if (!raw) continue;
    seats.push({
      display: raw.display,
      running: raw.running,
      hasViewer: raw.hasViewer,
      inflight: raw.inflight,
      lastActivityMs: raw.inflight ? boxTimeMs : raw.markerMs,
    });
  }
  return {
    boxTimeMs,
    supportsPark,
    memory: totalKb !== undefined ? { totalKb, availableKb, psiSomeAvg10 } : undefined,
    seats,
  };
}

function readShellExit(result) {
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

/** Periodic Fork desktop eviction loop driven by Box probes and active Bot checks. */
export function createDesktopEvictionLoop({
  ctx,
  desktops,
  config,
  readConfig,
  getActiveAgentIds,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  clock = { now: () => performance.now() },
  log = () => {},
  onStop,
}) {
  let bootBaselineMs;
  let unsupportedUntilMs;
  let timer = null;
  let polling = false;
  let cycle = 0;
  let rosterWaitCount = 0;
  const cooledSeats = new Set();
  const lastNonParkedOutcome = new Map();

  const makeSeatKey = seat => `${seat.agentId}:${seat.display}`;

  const runCycle = async () => {
    const activeConfig = readConfig ? readConfig() : config;
    if (!activeConfig?.enabled) return { status: 'disabled' };

    const activeAgentIds = getActiveAgentIds();
    if (activeAgentIds === undefined) {
      rosterWaitCount += 1;
      if (rosterWaitCount === 3 || (rosterWaitCount > 3 && rosterWaitCount % 10 === 0)) {
        log(`[grokbot-park] awaiting transcript roster (ticks=${rosterWaitCount})`);
      }
      return { status: 'roster-pending' };
    }
    rosterWaitCount = 0;

    const nowMono = clock.now();
    if (unsupportedUntilMs !== undefined && nowMono < unsupportedUntilMs) {
      return { status: 'unsupported' };
    }
    if (unsupportedUntilMs !== undefined) {
      unsupportedUntilMs = undefined;
      cooledSeats.clear();
    }

    const snapshot = await desktops.collectForkSeatSnapshots(ctx);
    if (snapshot === undefined) return { status: 'unsupported' };
    if (snapshot.supportsPark === false) {
      unsupportedUntilMs = clock.now() + UNSUPPORTED_COOLDOWN_MS;
      log('[grokbot-park] execution box stop-window lacks --park support; pausing for 60m');
      return { status: 'unsupported' };
    }
    if (bootBaselineMs === undefined) bootBaselineMs = snapshot.boxTimeMs;

    cycle += 1;
    const liveSeatKeys = new Set(snapshot.seats.map(makeSeatKey));
    for (const key of cooledSeats) {
      if (!liveSeatKeys.has(key)) cooledSeats.delete(key);
    }
    for (const key of lastNonParkedOutcome.keys()) {
      if (!liveSeatKeys.has(key)) lastNonParkedOutcome.delete(key);
    }

    const readySeats = [];
    for (const seat of snapshot.seats) {
      const key = makeSeatKey(seat);
      if (cooledSeats.has(key)) {
        cooledSeats.delete(key);
        continue;
      }
      readySeats.push(seat);
    }

    const plan = planDesktopEvictions({
      boxTimeMs: snapshot.boxTimeMs,
      bootBaselineMs,
      seats: readySeats,
      activeAgentIds,
      memory: snapshot.memory,
      config: activeConfig,
    });

    const actions = [];
    for (const target of plan.targets) {
      const key = makeSeatKey(target);
      let outcome;
      try {
        outcome = await desktops.sleepBotDesktop(ctx, target.agentId, {
          minIdleSeconds: target.minIdleSeconds,
        });
      } catch (error) {
        outcome = 'failed';
        if (lastNonParkedOutcome.get(key) !== outcome) {
          log(`[grokbot-park] seat=:${target.display} error: ${error?.message ?? String(error)}`);
        }
      }
      actions.push({ ...target, outcome });

      const idleMin = Math.floor(target.idleMs / MS_PER_MINUTE);
      if (outcome === 'parked') {
        lastNonParkedOutcome.delete(key);
        log(`[grokbot-park] seat=:${target.display} mode=${target.reason} idle=${idleMin}m status=parked`);
      } else {
        cooledSeats.add(key);
        if (lastNonParkedOutcome.get(key) !== outcome) {
          lastNonParkedOutcome.set(key, outcome);
          log(`[grokbot-park] seat=:${target.display} mode=${target.reason} idle=${idleMin}m status=${outcome}`);
        }
      }
    }

    return {
      status: 'completed',
      cycle,
      underMemoryPressure: plan.underMemoryPressure,
      runningSeats: snapshot.seats.filter(seat => seat.running).length,
      actions,
    };
  };

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await runCycle();
    } catch (error) {
      log(`[grokbot-park] probe error: ${error?.message ?? String(error)}`);
    } finally {
      polling = false;
    }
  };

  return {
    runCycle,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      onStop?.();
    },
  };
}

function makeAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'Aborted');
  err.name = 'AbortError';
  return err;
}

async function waitWithAbort(promise, signal) {
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) {
    throw makeAbortError(signal);
  }
  let onAbort;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(makeAbortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createComputerParkOverrides(original, log = () => {}) {
  const {
    SAND_BOX_FIRST_FORK_WINDOW_INDEX = BOX_CONTRACT.firstForkDisplay,
    SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE: origUnavailableCode,
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
    log(`[grokbot-park] overrides disabled: missing original computer dependencies (${missing.join(', ')})`);
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
      if (ownerToken !== undefined && !TOKEN_REGEX.test(ownerToken)) {
        throw new SandBoxWindowError('refusing to run start-window with a malformed owner token');
      }
      const result = await accessor.get(shellExecutorResource).execute(
        ctx,
        buildHostShellArgs({
          command: buildLockedStartWindowCommand(windowIndex, ownerToken),
          name: 'start-window',
          workingDirectory: '/workspace',
          toolCallId: 'sand-start-window',
        }),
      );
      const exited = readShellExit(result);
      if (!exited) {
        throw new SandBoxWindowError(`start-window failed (${result?.result?.case ?? 'unknown'})`);
      }
      if (typeof origUnavailableCode === 'number' && exited.exitCode === origUnavailableCode) {
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
          command: buildLockedStopWindowCommand(windowIndex),
          name: 'stop-window',
          workingDirectory: '/workspace',
          toolCallId: 'sand-stop-window',
        }),
      );
      const exited = readShellExit(result);
      if (!exited) {
        throw new SandBoxWindowError(`stop-window failed (${result?.result?.case ?? 'unknown'})`);
      }
      if (exited.exitCode !== 0) {
        throw new SandBoxWindowError(`stop-window exited ${exited.exitCode}: ${exited.stderr ?? ''}`);
      }
    },

    LoopbackSandBox: (BaseLoopbackSandBox, bindings) => {
      BaseLoopbackSandBox.prototype.probeForkSeats = async function probeForkSeats(ctx, agentId, displays) {
        const { buildHostShellArgs, SandBoxWindowError } = bindings;
        if (typeof buildHostShellArgs !== 'function' || SandBoxWindowError === undefined) {
          throw new Error('Missing Computer/Box runtime bindings for probeForkSeats');
        }
        const forkDisplays = displays.filter(
          display => Number.isInteger(display) && !isPrimaryWindowIndex(display),
        );
        const primary = await this.ensureReady(ctx, agentId);
        const result = await primary.remoteAccessor.get(shellExecutorResource).execute(
          ctx,
          buildHostShellArgs({
            command: buildSeatProbeCommand(forkDisplays),
            name: 'desktop-probe',
            workingDirectory: '/workspace',
            toolCallId: 'grokbot-desktop-probe',
          }),
        );
        const exited = readShellExit(result);
        if (!exited || exited.exitCode !== 0) {
          throw new SandBoxWindowError(`desktop probe failed (${result?.result?.case ?? 'unknown'})`);
        }
        const snapshot = parseSeatProbeOutput(exited.stdout, forkDisplays);
        if (snapshot === undefined) {
          throw new SandBoxWindowError('desktop probe output missing box clock');
        }
        return snapshot;
      };

      BaseLoopbackSandBox.prototype.evictForkDisplay = async function evictForkDisplay(ctx, agentId, display, opts) {
        const { buildHostShellArgs, sandBoxWindowKey } = bindings;
        if (typeof buildHostShellArgs !== 'function' || typeof sandBoxWindowKey !== 'function') {
          throw new DesktopParkError('Missing Computer/Box runtime bindings for evictForkDisplay', 'missing-bindings');
        }
        if (display == null || isPrimaryWindowIndex(display)) return 'not-running';
        const primary = await this.ensureReady(ctx, agentId);
        const result = await primary.remoteAccessor.get(shellExecutorResource).execute(
          ctx,
          buildHostShellArgs({
            command: buildSeatParkCommand(display, opts.ownerToken, opts.idleSeconds),
            name: 'park-seat',
            workingDirectory: '/workspace',
            toolCallId: 'grokbot-park-seat',
          }),
        );
        const exited = readShellExit(result);
        if (!exited) {
          throw new DesktopParkError(
            `Box shell execution failed (${result?.result?.case ?? 'unknown'})`,
            'shell-failed',
          );
        }
        if (exited.exitCode !== 0) {
          throw new DesktopParkError(
            `Park command did not finish cleanly (code ${exited.exitCode}): ${exited.stderr ?? ''}`,
            'unexpected-exit',
          );
        }
        const outcome = parseSeatParkOutput(exited.stdout);
        if (outcome === undefined) {
          throw new DesktopParkError('Park command emitted no status token', 'missing-status');
        }
        if (outcome === 'parked' || outcome === 'not-running' || outcome === 'not-owner') {
          this.windowConnections?.delete?.(sandBoxWindowKey(agentId, display));
        }
        return outcome;
      };

      return BaseLoopbackSandBox;
    },

    SharedDesktopSandBox: BaseSharedDesktopSandBox => {
      const origEnsureReady = BaseSharedDesktopSandBox.prototype.ensureReady;
      const origReleaseWindow = BaseSharedDesktopSandBox.prototype.releaseWindow;

      BaseSharedDesktopSandBox.prototype.serializeBotDesktopOp = function serializeBotDesktopOp(agentId, work, ctx) {
        if (ctx?.signal?.aborted) {
          return Promise.reject(makeAbortError(ctx.signal));
        }
        this._botDesktopQueues ??= new Map();
        const previous = this._botDesktopQueues.get(agentId) ?? Promise.resolve();
        let releaseTurn;
        const turnDone = new Promise(resolve => {
          releaseTurn = resolve;
        });
        // Even if this queued request is canceled before starting, keep the queue gate closed until
        // `previous` finishes so subsequent requests never overlap with the active holder.
        const gate = Promise.allSettled([previous, turnDone]).then(() => {});
        const tail = gate.finally(() => {
          if (this._botDesktopQueues.get(agentId) === tail) {
            this._botDesktopQueues.delete(agentId);
          }
        });
        this._botDesktopQueues.set(agentId, tail);

        return (async () => {
          try {
            await waitWithAbort(previous.catch(() => {}), ctx?.signal);
            return await work();
          } finally {
            releaseTurn();
          }
        })();
      };

      BaseSharedDesktopSandBox.prototype.ensureReady = function queuedEnsureReady(ctx, agentId) {
        return this.serializeBotDesktopOp(agentId, () => origEnsureReady.call(this, ctx, agentId), ctx);
      };

      BaseSharedDesktopSandBox.prototype.releaseWindow = function queuedReleaseWindow(ctx, agentId) {
        return this.serializeBotDesktopOp(agentId, () => origReleaseWindow.call(this, ctx, agentId), ctx);
      };

      BaseSharedDesktopSandBox.prototype.listActiveForkSeats = async function listActiveForkSeats(ctx) {
        await this.ensureAssignmentsLoaded(ctx);
        const seats = [];
        for (const [agentId, display] of this.agentWindows) {
          if (display < SAND_BOX_FIRST_FORK_WINDOW_INDEX) continue;
          const ownerToken = this.agentWindowTokens.get(agentId);
          if (!ownerToken) continue;
          if (!this.establishedForks.has(agentId) && !this.inheritedForks.has(agentId)) continue;
          seats.push({ agentId, display });
        }
        return seats;
      };

      BaseSharedDesktopSandBox.prototype.collectForkSeatSnapshots = async function collectForkSeatSnapshots(ctx) {
        if (typeof this.inner?.probeForkSeats !== 'function') return undefined;
        const seats = await this.listActiveForkSeats(ctx);
        const probe = await this.inner.probeForkSeats(
          ctx,
          this.sharedBoxId,
          seats.map(seat => seat.display),
        );
        const byDisplay = new Map(probe.seats.map(entry => [entry.display, entry]));
        return {
          boxTimeMs: probe.boxTimeMs,
          supportsPark: probe.supportsPark,
          memory: probe.memory,
          seats: seats.flatMap(seat => {
            const entry = byDisplay.get(seat.display);
            return entry === undefined ? [] : [{ ...entry, agentId: seat.agentId }];
          }),
        };
      };

      BaseSharedDesktopSandBox.prototype.sleepBotDesktop = function sleepBotDesktop(ctx, agentId, opts) {
        return this.serializeBotDesktopOp(agentId, async () => {
          if (typeof this.inner?.evictForkDisplay !== 'function') return 'failed';
          await this.ensureAssignmentsLoaded(ctx);
          const display = this.agentWindows.get(agentId);
          const ownerToken = this.agentWindowTokens.get(agentId);
          if (display === undefined || display < SAND_BOX_FIRST_FORK_WINDOW_INDEX || !ownerToken) {
            return 'not-running';
          }
          return await this.inner.evictForkDisplay(ctx, this.sharedBoxId, display, {
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
  if (typeof box.collectForkSeatSnapshots === 'function' && typeof box.sleepBotDesktop === 'function') {
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

  // In d0a4baa, runnerRegistry.runners is a Map keyed by session.id (Bot ID); runners themselves have no agentId.
  const runnerMap = transcriptApi?.runnerRegistry?.runners;
  const runnerEntries = typeof runnerMap?.entries === 'function'
    ? runnerMap.entries()
    : typeof transcriptApi?.runnerRegistry?.entries === 'function'
      ? transcriptApi.runnerRegistry.entries()
      : undefined;
  if (runnerEntries) {
    for (const [agentId, runner] of runnerEntries) {
      if (
        typeof agentId === 'string' &&
        agentId &&
        typeof runner?.hasRunningBackgroundShellWork === 'function' &&
        runner.hasRunningBackgroundShellWork()
      ) {
        live.add(agentId);
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
  if (!desktops || typeof library?.createContext !== 'function') {
    host?.log?.('[grokbot-park] skipped: shared execution desktop or host context is unavailable');
    return null;
  }
  const [baseCtx, cancel] = library.createContext().withCancel();
  const ctx = typeof baseCtx.withName === 'function' ? baseCtx.withName('idleDesktopPark') : baseCtx;
  const intervalMs = readDesktopParkIntervalMs(env);
  host?.log?.(
    `[grokbot-park] enabled: idleMinutes=${initialConfig.idleMinutes} pressureIdleMinutes=${initialConfig.pressureIdleMinutes} ` +
    `pressureAvailablePercent=${initialConfig.pressureAvailablePercent} pressurePsiSomeAvg10=${initialConfig.pressurePsiSomeAvg10} ` +
    `maxParksPerTick=${initialConfig.maxParksPerTick} intervalMs=${intervalMs}`,
  );
  const scheduler = createDesktopEvictionLoop({
    ctx,
    desktops,
    config: initialConfig,
    getActiveAgentIds: () => collectLiveAgentIds({ host, transcript, autoReview, session, desktops }),
    intervalMs,
    log: message => host?.log?.(message),
    onStop: () => cancel(new Error('idle desktop park stopped')),
  });
  scheduler.start();
  context?.onStop?.(() => scheduler.stop());
  return scheduler;
}
