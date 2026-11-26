// Opt-in idle Fork desktop parking and memory-pressure eviction for the shared Linux Box.
// Uses only the external execution-container interface (`/usr/local/bin/stop-window --park`,
// `/tmp/sand-window-used.d`, `/tmp/sand-window-tokens.d`, ports 14000+N / 5900+N, and
// `/proc/meminfo` + `/proc/pressure/memory`) with ProkBot Plus's own scheduler and probe logic.

const MINUTE_MS = 60_000;

export const DEFAULT_PARK_INTERVAL_MS = 60_000;
export const MIN_PARK_INTERVAL_MS = 10_000;
export const COMMAND_TIMEOUT_SECONDS = 150;
export const UNSUPPORTED_PAUSE_MS = 60 * MINUTE_MS;

export const DEFAULT_DESKTOP_PARK_CONFIG = Object.freeze({
  enabled: false,
  idleMinutes: 30,
  pressureIdleMinutes: 5,
  pressureAvailablePercent: 15,
  pressurePsiSomeAvg10: 10,
  maxParksPerTick: 5,
});

export const BOX_INTERFACE = Object.freeze({
  firstForkDisplay: 2,
  maxForkDisplay: 1000,
  execPortOffset: 14000,
  vncPortOffset: 5900,
  lockDir: '/tmp/sand-window-locks.d',
  tokenDir: '/tmp/sand-window-tokens.d',
  usedDir: '/tmp/sand-window-used.d',
  busyPrefix: '/tmp/sand-monitor-busy-',
  inflightSuffix: '.inflight',
  exitCodes: Object.freeze({
    ok: 0,
    unsupported: 74,
    notOwner: 75,
    lockBusy: 77,
    inUse: 78,
    notRunning: 79,
  }),
});

const LOCK_WAIT_SECONDS = 70;
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const PARK_STATUS_MAP = new Map([
  [BOX_INTERFACE.exitCodes.ok, 'parked'],
  [BOX_INTERFACE.exitCodes.inUse, 'in-use'],
  [BOX_INTERFACE.exitCodes.lockBusy, 'in-use'],
  [BOX_INTERFACE.exitCodes.notRunning, 'not-running'],
  [BOX_INTERFACE.exitCodes.notOwner, 'not-owner'],
  [BOX_INTERFACE.exitCodes.unsupported, 'unsupported'],
]);

export class DesktopParkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DesktopParkError';
    this.code = code;
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function wrapTimedShellCommand(innerCommand) {
  return `timeout -k 5 ${COMMAND_TIMEOUT_SECONDS} /bin/sh -c ${shellSingleQuote(innerCommand)}`;
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
  };
}

export function readDesktopParkIntervalMs(env = process.env) {
  return envPositiveNumber(env?.GROKBOT_DESKTOP_PARK_INTERVAL_MS, DEFAULT_PARK_INTERVAL_MS, {
    min: MIN_PARK_INTERVAL_MS,
  });
}

function hasMemoryPressure(memory, config) {
  if (!memory) return false;
  if (Number.isFinite(memory.totalKb) && memory.totalKb > 0 && Number.isFinite(memory.availableKb)) {
    const availablePct = (memory.availableKb / memory.totalKb) * 100;
    if (availablePct < config.pressureAvailablePercent) return true;
  }
  return Number.isFinite(memory.psiSomeAvg10) && memory.psiSomeAvg10 > config.pressurePsiSomeAvg10;
}

/** Choose eligible running Fork seats that exceeded the idle or memory-pressure threshold. */
export function selectWindowsToPark({
  boxTimeMs,
  baselineMs,
  seats,
  activeAgentIds,
  memory,
  config: rawConfig,
}) {
  const config = { ...DEFAULT_DESKTOP_PARK_CONFIG, ...rawConfig };
  const underMemoryPressure = hasMemoryPressure(memory, config);
  const thresholdMinutes = underMemoryPressure ? config.pressureIdleMinutes : config.idleMinutes;
  const thresholdMs = thresholdMinutes * MINUTE_MS;
  const reason = underMemoryPressure ? 'pressure' : 'idle';
  const minIdleSeconds = Math.round(thresholdMinutes * 60);
  const maxBatch = Math.max(0, config.maxParksPerTick);
  const anchorMs = baselineMs ?? boxTimeMs;

  const eligible = [];
  for (const seat of seats ?? []) {
    if (!Number.isInteger(seat?.display) || seat.display < BOX_INTERFACE.firstForkDisplay) continue;
    if (!seat.running || seat.hasViewer || activeAgentIds?.has(seat.agentId)) continue;
    const effectiveLastActiveMs = Math.max(seat.lastActivityMs ?? 0, anchorMs);
    const idleMs = Math.max(0, boxTimeMs - effectiveLastActiveMs);
    if (idleMs < thresholdMs) continue;
    eligible.push({
      agentId: seat.agentId,
      display: seat.display,
      reason,
      idleMs,
      minIdleSeconds,
    });
  }

  eligible.sort((a, b) => (b.idleMs - a.idleMs) || (a.display - b.display));
  return {
    underMemoryPressure,
    targets: eligible.slice(0, maxBatch),
  };
}

function assertValidForkDisplay(display, label) {
  if (!Number.isInteger(display) || display < BOX_INTERFACE.firstForkDisplay || display > BOX_INTERFACE.maxForkDisplay) {
    throw new DesktopParkError(`Invalid fork display for ${label}: ${String(display)}`, 'invalid-display');
  }
}

function assertValidOwnerToken(ownerToken, label) {
  if (typeof ownerToken !== 'string' || !OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new DesktopParkError(`Refusing to run ${label} with a malformed owner token`, 'malformed-owner-token');
  }
}

export function ensuredMarkerPath(display) {
  return `${BOX_INTERFACE.lockDir}/${display}.ensured`;
}

export function lockedStartWindowCommand(windowIndex, ownerToken) {
  assertValidForkDisplay(windowIndex, 'start-window');
  if (ownerToken !== undefined) assertValidOwnerToken(ownerToken, 'start-window');
  const script = ownerToken !== undefined
    ? `setpriv --pdeathsig KILL /usr/local/bin/start-window ${windowIndex} '${ownerToken}'`
    : `setpriv --pdeathsig KILL /usr/local/bin/start-window ${windowIndex}`;
  return wrapTimedShellCommand(
    `mkdir -p ${BOX_INTERFACE.lockDir} && ` +
    `exec 9>>${BOX_INTERFACE.lockDir}/${windowIndex} && ` +
    `flock -w ${LOCK_WAIT_SECONDS} 9 || exit ${BOX_INTERFACE.exitCodes.lockBusy}; ` +
    `${script} 9>&-; sx=$?; ` +
    `if [ "$sx" -eq 0 ]; then touch ${ensuredMarkerPath(windowIndex)} 2>/dev/null || true; fi; ` +
    `exit "$sx"`,
  );
}

export function lockedStopWindowCommand(windowIndex) {
  assertValidForkDisplay(windowIndex, 'stop-window');
  return wrapTimedShellCommand(
    `mkdir -p ${BOX_INTERFACE.lockDir} && ` +
    `exec 9>>${BOX_INTERFACE.lockDir}/${windowIndex} && ` +
    `flock -w ${LOCK_WAIT_SECONDS} 9 || exit ${BOX_INTERFACE.exitCodes.lockBusy}; ` +
    `rm -f ${ensuredMarkerPath(windowIndex)} 2>/dev/null || true; ` +
    `setpriv --pdeathsig KILL /usr/local/bin/stop-window ${windowIndex} 9>&-; sx=$?; ` +
    `exit "$sx"`,
  );
}

/** Build the locked Box shell script that verifies idleness and parks a Fork display. */
export function buildParkShellScript(display, ownerToken, idleSeconds) {
  assertValidForkDisplay(display, 'park-window');
  assertValidOwnerToken(ownerToken, 'park-window');
  if (!Number.isInteger(idleSeconds) || idleSeconds < 0) {
    throw new DesktopParkError('Invalid idle threshold for park-window', 'malformed-idle-threshold');
  }
  const execPort = BOX_INTERFACE.execPortOffset + display;
  const vncPort = BOX_INTERFACE.vncPortOffset + display;
  const lockFile = `${BOX_INTERFACE.lockDir}/${display}`;
  const tokenFile = `${BOX_INTERFACE.tokenDir}/${display}`;
  const inflightFile = `${BOX_INTERFACE.usedDir}/${display}${BOX_INTERFACE.inflightSuffix}`;
  const markerFiles = [
    `${BOX_INTERFACE.usedDir}/${display}`,
    `${BOX_INTERFACE.busyPrefix}${display}`,
    ensuredMarkerPath(display),
  ].join(' ');
  const codes = BOX_INTERFACE.exitCodes;
  const lines = [
    `grep -qF -- --park /usr/local/bin/stop-window 2>/dev/null || exit ${codes.unsupported}`,
    `mkdir -p ${BOX_INTERFACE.lockDir} && exec 9>>${lockFile} && flock -n 9 || exit ${codes.lockBusy}`,
    `saved_token=$(cat ${tokenFile} 2>/dev/null || true)`,
    `[ "$saved_token" = '${ownerToken}' ] || exit ${codes.notOwner}`,
    `if ! xdpyinfo -display :${display} >/dev/null 2>&1 && ! ss -ltnH "sport = :${execPort}" 2>/dev/null | grep -q .; then exit ${codes.notRunning}; fi`,
    `[ ! -e ${inflightFile} ] || exit ${codes.inUse}`,
    `ss -tnH state established "( sport = :${vncPort} )" 2>/dev/null | grep -q . && exit ${codes.inUse}`,
    'now_sec=$(date +%s)',
    `for marker in ${markerFiles}; do`,
    '  mtime=$(stat -c %Y "$marker" 2>/dev/null) || continue',
    `  [ $((now_sec - mtime)) -lt ${idleSeconds} ] && exit ${codes.inUse}`,
    'done',
    `x_pid=$(tr -dc 0-9 2>/dev/null < /tmp/.X${display}-lock || true)`,
    `setpriv --pdeathsig KILL /usr/local/bin/stop-window --park ${display} 9>&-`,
    'rc=$?',
    'if [ -n "$x_pid" ]; then',
    '  tries=0',
    '  while [ "$tries" -lt 50 ] && kill -0 "$x_pid" 2>/dev/null; do',
    '    sleep 0.1',
    '    tries=$((tries + 1))',
    '  done',
    'fi',
    'exit "$rc"',
  ];
  return wrapTimedShellCommand(lines.join('\n'));
}

/** Build a single Box shell probe reading wall clock, memory, PSI, and Fork display states. */
export function buildBoxProbeScript(displays) {
  const forkDisplays = (Array.isArray(displays) ? displays : []).filter(
    display => Number.isInteger(display) && display >= BOX_INTERFACE.firstForkDisplay && display <= BOX_INTERFACE.maxForkDisplay,
  );
  const lines = [
    'now_sec=$(date +%s)',
    'printf "TIME=%s\\n" "$now_sec"',
    `awk '/^MemTotal:/{tot=$2} /^MemAvailable:/{avail=$2} END{if(tot>0) printf "MEM=%d:%d\\n", tot, avail+0}' /proc/meminfo 2>/dev/null || true`,
    `awk '/^some /{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub(/^avg10=/,"",$i); printf "PSI=%s\\n", $i; exit}}' /proc/pressure/memory 2>/dev/null || true`,
  ];
  if (forkDisplays.length > 0) {
    lines.push(
      'listening_ports=$(ss -ltnH 2>/dev/null | awk \'{print $4}\')',
      'established_ports=$(ss -tnH state established 2>/dev/null | awk \'{print $3}\')',
      `for d in ${forkDisplays.join(' ')}; do`,
      `  exec_port=$((${BOX_INTERFACE.execPortOffset} + d))`,
      `  vnc_port=$((${BOX_INTERFACE.vncPortOffset} + d))`,
      '  alive=0',
      '  if [ -S "/tmp/.X11-unix/X$d" ] || printf "%s\\n" "$listening_ports" | grep -q ":$exec_port$"; then alive=1; fi',
      '  latest=0',
      `  if [ -e "${BOX_INTERFACE.usedDir}/$d${BOX_INTERFACE.inflightSuffix}" ]; then`,
      '    latest=$now_sec',
      '  else',
      `    for marker in "${BOX_INTERFACE.usedDir}/$d" "${BOX_INTERFACE.busyPrefix}$d" "${BOX_INTERFACE.lockDir}/$d.ensured"; do`,
      '      ts=$(stat -c %Y "$marker" 2>/dev/null || echo 0)',
      '      if [ "$ts" -gt "$latest" ] 2>/dev/null; then latest=$ts; fi',
      '    done',
      '  fi',
      '  viewer=0',
      '  if printf "%s\\n" "$established_ports" | grep -q ":$vnc_port$"; then viewer=1; fi',
      '  printf "SEAT=%s:%s:%s:%s\\n" "$d" "$alive" "$latest" "$viewer"',
      'done',
    );
  }
  return wrapTimedShellCommand(lines.join('\n'));
}

function parseEpochMs(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return seconds > 0 ? seconds * 1000 : undefined;
}

/** Parse stdout from `buildBoxProbeScript` into Box time, memory stats, and seat activity. */
export function parseBoxProbeOutput(stdout, allowedDisplays) {
  let boxTimeMs;
  let totalKb;
  let availableKb;
  let psiSomeAvg10;
  const allowed = new Set(allowedDisplays);
  const seatByDisplay = new Map();

  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('TIME=')) {
      boxTimeMs = parseEpochMs(line.slice(5));
    } else if (line.startsWith('MEM=')) {
      const [totStr = '', availStr = ''] = line.slice(4).split(':');
      const tot = Number.parseInt(totStr, 10);
      const avail = Number.parseInt(availStr, 10);
      if (Number.isInteger(tot) && tot > 0 && Number.isInteger(avail) && avail >= 0) {
        totalKb = tot;
        availableKb = avail;
      }
    } else if (line.startsWith('PSI=')) {
      const psi = Number.parseFloat(line.slice(4));
      if (Number.isFinite(psi) && psi >= 0) psiSomeAvg10 = psi;
    } else if (line.startsWith('SEAT=')) {
      const parts = line.slice(5).split(':');
      if (parts.length !== 4) continue;
      const display = Number.parseInt(parts[0], 10);
      if (!allowed.has(display)) continue;
      seatByDisplay.set(display, {
        display,
        running: parts[1] === '1',
        lastActivityMs: parseEpochMs(parts[2]),
        hasViewer: parts[3] === '1',
      });
    }
  }

  if (boxTimeMs === undefined) return undefined;
  const seats = [];
  for (const display of allowedDisplays) {
    const entry = seatByDisplay.get(display);
    if (entry) seats.push(entry);
  }
  return {
    boxTimeMs,
    memory: totalKb !== undefined ? { totalKb, availableKb, psiSomeAvg10 } : undefined,
    seats,
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

/** Periodic Fork desktop sleep scheduler driven by Box probes and active Bot checks. */
export function createDesktopSleepScheduler({
  ctx,
  desktops,
  config,
  readConfig,
  getActiveAgentIds,
  intervalMs = DEFAULT_PARK_INTERVAL_MS,
  clock = { now: () => performance.now() },
  log = () => {},
  onStop,
}) {
  let baselineMs;
  let unsupportedUntilMs;
  let timer = null;
  let inFlight = false;
  let cycleSeq = 0;
  let rosterPendingCount = 0;
  const skipNextCycle = new Set();

  const seatId = seat => `${seat.agentId}:${seat.display}`;

  const runCycle = async () => {
    const activeConfig = readConfig ? readConfig() : config;
    if (!activeConfig?.enabled) return { status: 'disabled' };

    const activeAgentIds = getActiveAgentIds();
    if (activeAgentIds === undefined) {
      rosterPendingCount += 1;
      if (rosterPendingCount === 3 || (rosterPendingCount > 3 && rosterPendingCount % 10 === 0)) {
        log(`[desktop-park] waiting for transcript roster (cycles=${rosterPendingCount})`);
      }
      return { status: 'roster-pending' };
    }
    rosterPendingCount = 0;

    const nowMono = clock.now();
    if (unsupportedUntilMs !== undefined && nowMono < unsupportedUntilMs) {
      return { status: 'unsupported' };
    }
    unsupportedUntilMs = undefined;

    const probe = await desktops.snapshotForkDesktops(ctx);
    if (probe === undefined) return { status: 'unsupported' };
    if (baselineMs === undefined) baselineMs = probe.boxTimeMs;

    cycleSeq += 1;
    const currentKeys = new Set(probe.seats.map(seatId));
    for (const key of skipNextCycle) {
      if (!currentKeys.has(key)) skipNextCycle.delete(key);
    }

    const eligibleSeats = [];
    for (const seat of probe.seats) {
      const key = seatId(seat);
      if (skipNextCycle.has(key)) {
        // Wait one cycle after a failed/busy attempt before retrying the same seat.
        skipNextCycle.delete(key);
        continue;
      }
      eligibleSeats.push(seat);
    }

    const plan = selectWindowsToPark({
      boxTimeMs: probe.boxTimeMs,
      baselineMs,
      seats: eligibleSeats,
      activeAgentIds,
      memory: probe.memory,
      config: activeConfig,
    });

    const actions = [];
    for (const target of plan.targets) {
      let outcome;
      try {
        outcome = await desktops.parkAgentWindow(ctx, target.agentId, {
          minIdleSeconds: target.minIdleSeconds,
        });
      } catch (error) {
        log(`[desktop-park] :${target.display} error: ${error?.message ?? String(error)}`);
        outcome = 'failed';
      }
      actions.push({ ...target, outcome });
      const idleMin = Math.floor(target.idleMs / MINUTE_MS);
      log(`[desktop-park] :${target.display} reason=${target.reason} idle=${idleMin}m outcome=${outcome}`);

      if (outcome === 'unsupported') {
        unsupportedUntilMs = clock.now() + UNSUPPORTED_PAUSE_MS;
        log('[desktop-park] box image lacks --park support; pausing for 60m');
        break;
      }
      if (outcome !== 'parked') {
        skipNextCycle.add(seatId(target));
      }
    }

    return {
      status: 'completed',
      cycle: cycleSeq,
      underMemoryPressure: plan.underMemoryPressure,
      runningSeats: probe.seats.filter(seat => seat.running).length,
      actions,
    };
  };

  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runCycle();
    } catch (error) {
      log(`[desktop-park] probe failed: ${error?.message ?? String(error)}`);
    } finally {
      inFlight = false;
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
    SAND_BOX_FIRST_FORK_WINDOW_INDEX = BOX_INTERFACE.firstForkDisplay,
    SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE: origUnavailableCode = BOX_INTERFACE.exitCodes.notOwner,
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
    log(`[desktop-park] overrides disabled: missing original computer dependencies (${missing.join(', ')})`);
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
      BaseLoopbackSandBox.prototype.readDesktopActivity = async function readDesktopActivity(ctx, agentId, displays) {
        const { buildHostShellArgs, SandBoxWindowError } = bindings;
        if (typeof buildHostShellArgs !== 'function' || SandBoxWindowError === undefined) {
          throw new Error('Missing Computer/Box runtime bindings for readDesktopActivity');
        }
        const forkDisplays = displays.filter(
          display => Number.isInteger(display) && !isPrimaryWindowIndex(display),
        );
        const primary = await this.ensureReady(ctx, agentId);
        const result = await primary.remoteAccessor.get(shellExecutorResource).execute(
          ctx,
          buildHostShellArgs({
            command: buildBoxProbeScript(forkDisplays),
            name: 'desktop-activity',
            workingDirectory: '/workspace',
            toolCallId: 'sand-desktop-activity',
          }),
        );
        const exited = extractShellExit(result);
        if (!exited || exited.exitCode !== 0) {
          throw new SandBoxWindowError(`desktop-activity failed (${result?.result?.case ?? 'unknown'})`);
        }
        const probe = parseBoxProbeOutput(exited.stdout, forkDisplays);
        if (probe === undefined) {
          throw new SandBoxWindowError('desktop-activity printed no box clock');
        }
        return probe;
      };

      BaseLoopbackSandBox.prototype.parkWindow = async function parkWindow(ctx, agentId, display, opts) {
        const { buildHostShellArgs, sandBoxWindowKey } = bindings;
        if (typeof buildHostShellArgs !== 'function' || typeof sandBoxWindowKey !== 'function') {
          throw new DesktopParkError('Missing Computer/Box runtime bindings for parkWindow', 'missing-bindings');
        }
        if (display == null || isPrimaryWindowIndex(display)) return 'not-running';
        const primary = await this.ensureReady(ctx, agentId);
        const result = await primary.remoteAccessor.get(shellExecutorResource).execute(
          ctx,
          buildHostShellArgs({
            command: buildParkShellScript(display, opts.ownerToken, opts.idleSeconds),
            name: 'park-window',
            workingDirectory: '/workspace',
            toolCallId: 'sand-park-window',
          }),
        );
        const exited = extractShellExit(result);
        if (!exited) {
          throw new DesktopParkError(
            `park-window failed (${result?.result?.case ?? 'unknown'})`,
            `result-${result?.result?.case ?? 'unknown'}`,
          );
        }
        const outcome = PARK_STATUS_MAP.get(exited.exitCode);
        if (outcome === undefined) {
          throw new DesktopParkError(
            `park-window exited ${exited.exitCode}: ${exited.stderr ?? ''}`,
            `exit-${exited.exitCode}`,
          );
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
        for (const [agentId, display] of this.agentWindows) {
          if (display < SAND_BOX_FIRST_FORK_WINDOW_INDEX) continue;
          const ownerToken = this.agentWindowTokens.get(agentId);
          if (!ownerToken) continue;
          if (!this.establishedForks.has(agentId) && !this.inheritedForks.has(agentId)) continue;
          seats.push({ agentId, display });
        }
        return seats;
      };

      BaseSharedDesktopSandBox.prototype.snapshotForkDesktops = async function snapshotForkDesktops(ctx) {
        if (typeof this.inner?.readDesktopActivity !== 'function') return undefined;
        const seats = await this.startedForkSeats(ctx);
        const probe = await this.inner.readDesktopActivity(
          ctx,
          this.sharedBoxId,
          seats.map(seat => seat.display),
        );
        const byDisplay = new Map(probe.seats.map(entry => [entry.display, entry]));
        return {
          boxTimeMs: probe.boxTimeMs,
          memory: probe.memory,
          seats: seats.flatMap(seat => {
            const entry = byDisplay.get(seat.display);
            return entry === undefined ? [] : [{ ...entry, agentId: seat.agentId }];
          }),
        };
      };

      BaseSharedDesktopSandBox.prototype.parkAgentWindow = function parkAgentWindow(ctx, agentId, opts) {
        return this.inAgentQueue(agentId, async () => {
          if (typeof this.inner?.parkWindow !== 'function') return 'unsupported';
          await this.ensureAssignmentsLoaded(ctx);
          const display = this.agentWindows.get(agentId);
          const ownerToken = this.agentWindowTokens.get(agentId);
          if (display === undefined || display < SAND_BOX_FIRST_FORK_WINDOW_INDEX || !ownerToken) {
            return 'no-seat';
          }
          return await this.inner.parkWindow(ctx, this.sharedBoxId, display, {
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
  if (!desktops || typeof library?.createContext !== 'function') return null;
  const [baseCtx, cancel] = library.createContext().withCancel();
  const ctx = typeof baseCtx.withName === 'function' ? baseCtx.withName('idleDesktopPark') : baseCtx;
  const intervalMs = readDesktopParkIntervalMs(env);
  host?.log?.(
    `[desktop-park] enabled: idleMinutes=${initialConfig.idleMinutes} pressureIdleMinutes=${initialConfig.pressureIdleMinutes} ` +
    `pressureAvailablePercent=${initialConfig.pressureAvailablePercent} pressurePsiSomeAvg10=${initialConfig.pressurePsiSomeAvg10} ` +
    `maxParksPerTick=${initialConfig.maxParksPerTick} intervalMs=${intervalMs}`,
  );
  const scheduler = createDesktopSleepScheduler({
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
