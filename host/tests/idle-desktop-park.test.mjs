import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  BOX_CONTRACT,
  DEFAULT_PARK_POLICY,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  UNSUPPORTED_COOLDOWN_MS,
  buildLockedStartWindowCommand,
  buildLockedStopWindowCommand,
  buildSeatParkCommand,
  buildSeatProbeCommand,
  collectLiveAgentIds,
  createComputerParkOverrides,
  createDesktopEvictionLoop,
  parseSeatParkOutput,
  parseSeatProbeOutput,
  planDesktopEvictions,
  readDesktopParkConfig,
  readDesktopParkIntervalMs,
  resolveSharedDesktopBox,
  startLocalIdleDesktopPark,
} from '../runtime/idle-desktop-park.mjs';
import { installRecoveredComputer } from '../runtime/recovered-computer.mjs';

function findPosixShell() {
  if (process.platform !== 'win32' && existsSync('/bin/sh')) return '/bin/sh';
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(lookupCmd, ['sh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    return found && existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

const posixShell = findPosixShell();

test('readDesktopParkConfig defaults to disabled and honors valid env overrides', () => {
  assert.equal(DEFAULT_PARK_POLICY.enabled, false);
  assert.deepEqual(readDesktopParkConfig({}), DEFAULT_PARK_POLICY);
  assert.equal(readDesktopParkIntervalMs({}), 60_000);

  const custom = readDesktopParkConfig({
    GROKBOT_DESKTOP_PARK_ENABLED: '1',
    GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '20',
    GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES: '3',
    GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT: '18.5',
    GROKBOT_DESKTOP_PARK_PRESSURE_PSI: '7.5',
    GROKBOT_DESKTOP_PARK_MAX_PER_TICK: '0',
  });
  assert.equal(custom.enabled, true);
  assert.equal(custom.idleMinutes, 20);
  assert.equal(custom.pressureIdleMinutes, 3);
  assert.equal(custom.pressureAvailablePercent, 18.5);
  assert.equal(custom.pressurePsiSomeAvg10, 7.5);
  assert.equal(custom.maxParksPerTick, 0);

  const fallback = readDesktopParkConfig({
    GROKBOT_DESKTOP_PARK_ENABLED: 'maybe',
    GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '-5',
    GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES: '1.5',
    GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT: '105',
    GROKBOT_DESKTOP_PARK_PRESSURE_PSI: '12px',
    GROKBOT_DESKTOP_PARK_MAX_PER_TICK: '30s',
  });
  assert.deepEqual(fallback, DEFAULT_PARK_POLICY);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '1.5' }), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '60s' }), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '5000' }), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: String(MIN_POLL_INTERVAL_MS) }), 10_000);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '15000' }), 15_000);
});

test('planDesktopEvictions picks >30m idle forks and skips primary, stopped, VNC-viewed, inflight, and live bots', () => {
  const bootBaselineMs = 1_000_000;
  const boxTimeMs = bootBaselineMs + 45 * 60_000;
  const plan = planDesktopEvictions({
    boxTimeMs,
    bootBaselineMs,
    activeAgentIds: new Set(['agent-live']),
    memory: { totalKb: 16 * 1024 * 1024, availableKb: 10 * 1024 * 1024, psiSomeAvg10: 0 },
    seats: [
      { agentId: 'agent-primary', display: 1, running: true, lastActivityMs: bootBaselineMs - 60_000, hasViewer: false, inflight: false },
      { agentId: 'agent-stopped', display: 2, running: false, lastActivityMs: bootBaselineMs - 60_000, hasViewer: false, inflight: false },
      { agentId: 'agent-vnc', display: 3, running: true, lastActivityMs: bootBaselineMs - 60_000, hasViewer: true, inflight: false },
      { agentId: 'agent-inflight', display: 4, running: true, lastActivityMs: bootBaselineMs - 60_000, hasViewer: false, inflight: true },
      { agentId: 'agent-live', display: 5, running: true, lastActivityMs: bootBaselineMs - 60_000, hasViewer: false, inflight: false },
      { agentId: 'agent-recent', display: 6, running: true, lastActivityMs: boxTimeMs - 10 * 60_000, hasViewer: false, inflight: false },
      { agentId: 'agent-idle-a', display: 8, running: true, lastActivityMs: boxTimeMs - 31 * 60_000, hasViewer: false, inflight: false },
      { agentId: 'agent-idle-b', display: 7, running: true, lastActivityMs: boxTimeMs - 40 * 60_000, hasViewer: false, inflight: false },
    ],
  });

  assert.equal(plan.underMemoryPressure, false);
  assert.deepEqual(
    plan.targets.map(entry => ({ agentId: entry.agentId, display: entry.display, reason: entry.reason, minIdleSeconds: entry.minIdleSeconds })),
    [
      { agentId: 'agent-idle-b', display: 7, reason: 'idle', minIdleSeconds: 1800 },
      { agentId: 'agent-idle-a', display: 8, reason: 'idle', minIdleSeconds: 1800 },
    ],
  );
});

test('planDesktopEvictions uses shorter threshold, LRU order, and batch limit under MemAvailable or PSI pressure', () => {
  const bootBaselineMs = 1_000_000;
  const boxTimeMs = bootBaselineMs + 20 * 60_000;
  const totalKb = 16 * 1024 * 1024;
  const availableKb = 1.5 * 1024 * 1024;

  const plan = planDesktopEvictions({
    boxTimeMs,
    bootBaselineMs,
    activeAgentIds: new Set(),
    memory: { totalKb, availableKb, psiSomeAvg10: 0 },
    config: { ...DEFAULT_PARK_POLICY, enabled: true, maxParksPerTick: 2 },
    seats: [
      { agentId: 'too-fresh', display: 2, running: true, lastActivityMs: boxTimeMs - 2 * 60_000, hasViewer: false, inflight: false },
      { agentId: 'lru-1', display: 3, running: true, lastActivityMs: boxTimeMs - 18 * 60_000, hasViewer: false, inflight: false },
      { agentId: 'lru-2', display: 4, running: true, lastActivityMs: boxTimeMs - 12 * 60_000, hasViewer: false, inflight: false },
      { agentId: 'lru-3', display: 5, running: true, lastActivityMs: boxTimeMs - 7 * 60_000, hasViewer: false, inflight: false },
    ],
  });

  assert.equal(plan.underMemoryPressure, true);
  assert.deepEqual(
    plan.targets.map(entry => ({ agentId: entry.agentId, reason: entry.reason, minIdleSeconds: entry.minIdleSeconds })),
    [
      { agentId: 'lru-1', reason: 'pressure', minIdleSeconds: 300 },
      { agentId: 'lru-2', reason: 'pressure', minIdleSeconds: 300 },
    ],
  );

  // PSI pressure alone also activates the shorter threshold
  const psiPlan = planDesktopEvictions({
    boxTimeMs,
    bootBaselineMs,
    activeAgentIds: new Set(),
    memory: { totalKb, availableKb: 10 * 1024 * 1024, psiSomeAvg10: 12.4 },
    seats: [{ agentId: 'lru-psi', display: 3, running: true, lastActivityMs: boxTimeMs - 6 * 60_000, hasViewer: false, inflight: false }],
  });
  assert.equal(psiPlan.underMemoryPressure, true);
  assert.equal(psiPlan.targets.length, 1);
  assert.equal(psiPlan.targets[0].reason, 'pressure');

  // maxParksPerTick=0 suppresses parking even under pressure
  const capped = planDesktopEvictions({
    boxTimeMs,
    bootBaselineMs,
    activeAgentIds: new Set(),
    memory: { totalKb, availableKb, psiSomeAvg10: 25 },
    config: { ...DEFAULT_PARK_POLICY, enabled: true, maxParksPerTick: 0 },
    seats: [{ agentId: 'lru-1', display: 3, running: true, lastActivityMs: boxTimeMs - 18 * 60_000, hasViewer: false, inflight: false }],
  });
  assert.deepEqual(capped.targets, []);
});

test('window commands use /tmp/grokbot-park.d locks, stdout outcomes, and parse probe records', () => {
  assert.throws(() => buildSeatParkCommand(1, 'valid-token', 1800), /Invalid fork display/);
  assert.throws(() => buildSeatParkCommand(2, 'bad token; rm -rf /', 1800), /malformed owner token/);
  assert.throws(() => buildLockedStartWindowCommand(2, "bad'quote"), /malformed owner token/);

  const startCmd = buildLockedStartWindowCommand(17, 'token_abc-123');
  assert.match(startCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(startCmd, /\/tmp\/grokbot-park\.d\/seat-17\.lock/);
  assert.match(startCmd, /flock -w 45 9/);
  assert.match(startCmd, /setpriv --pdeathsig KILL \/usr\/local\/bin\/start-window 17 '\\''token_abc-123'\\'' 9>&-/);
  assert.match(startCmd, /touch \/tmp\/grokbot-park\.d\/seat-17\.woken/);
  assert.doesNotMatch(startCmd, /sand-window-locks\.d/);

  const stopCmd = buildLockedStopWindowCommand(17);
  assert.match(stopCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(stopCmd, /setpriv --pdeathsig KILL \/usr\/local\/bin\/stop-window 17 9>&-/);
  assert.match(stopCmd, /rm -f \/tmp\/grokbot-park\.d\/seat-17\.woken/);

  const parkCmd = buildSeatParkCommand(17, 'token_abc-123', 1800);
  assert.match(parkCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(parkCmd, /flock -n 9/);
  assert.match(parkCmd, /setpriv --pdeathsig KILL \/usr\/local\/bin\/stop-window --park 17 9>&-/);
  assert.match(parkCmd, /GROKBOT_PARK_STATUS=parked/);
  assert.match(parkCmd, /sport = :5917/);
  assert.match(parkCmd, /sport = :14017/);
  assert.doesNotMatch(parkCmd, /--park \/usr\/local\/bin\/stop-window/);
  assert.doesNotMatch(parkCmd, /exit 7[45789]/);

  assert.equal(parseSeatParkOutput('noise\nGROKBOT_PARK_STATUS=parked\n'), 'parked');
  assert.equal(parseSeatParkOutput('GROKBOT_PARK_STATUS=not-owner'), 'not-owner');
  assert.equal(parseSeatParkOutput('GROKBOT_PARK_STATUS=unknown'), undefined);

  const probeCmd = buildSeatProbeCommand([1, 2, 17]);
  assert.match(probeCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(probeCmd, /for d in 2 17; do/);
  assert.match(probeCmd, /grep -qF -- --park \/usr\/local\/bin\/stop-window/);

  const parsed = parseSeatProbeOutput(
    [
      'clock\t1795622853',
      'cap\t1',
      'mem\t16133452\t3000000',
      'psi\t4.25',
      'seat\t2\t1\t0\t0\t0\t1795621000',
      'seat\t17\t0\t0\t1\t1\t0',
      'seat\t99\t1\t1\t0\t0\t1795622000',
    ].join('\n'),
    [2, 17],
  );
  assert.deepEqual(parsed, {
    boxTimeMs: 1795622853 * 1000,
    supportsPark: true,
    memory: { totalKb: 16133452, availableKb: 3000000, psiSomeAvg10: 4.25 },
    seats: [
      { display: 2, running: true, hasViewer: false, inflight: false, lastActivityMs: 1795621000 * 1000 },
      { display: 17, running: false, hasViewer: true, inflight: true, lastActivityMs: 1795622853 * 1000 },
    ],
  });
});

test(
  'generated box shell scripts pass POSIX sh -n syntax check',
  { skip: !posixShell && 'POSIX sh executable not available on this platform' },
  () => {
    const scripts = [
      buildLockedStartWindowCommand(17, 'token_abc-123'),
      buildLockedStopWindowCommand(17),
      buildSeatParkCommand(17, 'token_abc-123', 1800),
      buildSeatProbeCommand([1, 2, 17]),
      buildSeatProbeCommand([]),
    ];
    for (const cmd of scripts) {
      execFileSync(posixShell, ['-n', '-c', cmd]);
    }
  },
);

test('createDesktopEvictionLoop deduplicates repeated non-parked logs, skips 1 cycle on failure, and pauses when probe reports cap=0', async () => {
  let monoMs = 10_000;
  let boxTimeMs = 1_000_000;
  let supportsPark = true;
  let outcomes = ['not-owner', 'not-owner', 'busy'];
  let rosterReady = false;
  const logs = [];

  const scheduler = createDesktopEvictionLoop({
    ctx: {},
    clock: { now: () => monoMs },
    intervalMs: 60_000,
    readConfig: () => ({ ...DEFAULT_PARK_POLICY, enabled: true }),
    getActiveAgentIds: () => (rosterReady ? new Set() : undefined),
    log: message => logs.push(message),
    desktops: {
      collectForkSeatSnapshots: async () => ({
        boxTimeMs,
        supportsPark,
        memory: { totalKb: 16_000_000, availableKb: 8_000_000, psiSomeAvg10: 0 },
        seats: [{ agentId: 'a1', display: 2, running: true, lastActivityMs: boxTimeMs - 40 * 60_000, hasViewer: false, inflight: false }],
      }),
      sleepBotDesktop: async () => outcomes.shift() ?? 'parked',
    },
  });

  assert.equal((await scheduler.runCycle()).status, 'roster-pending');
  assert.equal((await scheduler.runCycle()).status, 'roster-pending');
  assert.equal((await scheduler.runCycle()).status, 'roster-pending');
  assert.equal(logs.filter(line => line.includes('awaiting transcript roster')).length, 1);
  rosterReady = true;

  // Cycle 1 initializes bootBaselineMs -> no park yet
  let res = await scheduler.runCycle();
  assert.equal(res.actions.length, 0);

  // Advance past 30m idle -> parks a1, receives 'not-owner' -> logs once and cools down 1 cycle
  monoMs += 31 * 60_000;
  boxTimeMs += 31 * 60_000;
  res = await scheduler.runCycle();
  assert.equal(res.actions[0].outcome, 'not-owner');
  assert.equal(logs.filter(line => line.includes('status=not-owner')).length, 1);

  // Next cycle skips a1 (cooldown)
  monoMs += 60_000;
  boxTimeMs += 60_000;
  res = await scheduler.runCycle();
  assert.equal(res.actions.length, 0);

  // Following cycle gets 'not-owner' again -> outcome unchanged, so NO duplicate log line
  monoMs += 60_000;
  boxTimeMs += 60_000;
  res = await scheduler.runCycle();
  assert.equal(res.actions[0].outcome, 'not-owner');
  assert.equal(logs.filter(line => line.includes('status=not-owner')).length, 1);

  // Skip 1 cycle, then outcome changes to 'busy' -> logs the state transition
  monoMs += 60_000;
  boxTimeMs += 60_000;
  await scheduler.runCycle();
  monoMs += 60_000;
  boxTimeMs += 60_000;
  res = await scheduler.runCycle();
  assert.equal(res.actions[0].outcome, 'busy');
  assert.equal(logs.filter(line => line.includes('status=busy')).length, 1);

  // Probe reports supportsPark=false -> pauses for UNSUPPORTED_COOLDOWN_MS without calling sleepBotDesktop
  supportsPark = false;
  monoMs += 60_000;
  boxTimeMs += 60_000;
  res = await scheduler.runCycle();
  assert.equal(res.status, 'unsupported');
  assert.equal(logs.filter(line => line.includes('lacks --park support')).length, 1);

  // During cooldown window, does not re-probe
  supportsPark = true;
  monoMs += 60_000;
  boxTimeMs += 60_000;
  res = await scheduler.runCycle();
  assert.equal(res.status, 'unsupported');

  // After cooldown window, resumes and parks cleanly
  monoMs += UNSUPPORTED_COOLDOWN_MS;
  boxTimeMs += UNSUPPORTED_COOLDOWN_MS;
  outcomes = ['parked'];
  res = await scheduler.runCycle();
  assert.equal(res.status, 'completed');
  assert.equal(res.actions[0].outcome, 'parked');
});

test('createDesktopEvictionLoop logs probe errors once per interval and recovers on later probes', async () => {
  const logs = [];
  let boxReachable = false;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  let scheduledCallback;
  globalThis.setInterval = fn => {
    scheduledCallback = fn;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {
    scheduledCallback = undefined;
  };
  try {
    const scheduler = createDesktopEvictionLoop({
      ctx: {},
      config: { ...DEFAULT_PARK_POLICY, enabled: true },
      getActiveAgentIds: () => new Set(),
      intervalMs: 60_000,
      log: message => logs.push(message),
      desktops: {
        collectForkSeatSnapshots: async () => {
          if (!boxReachable) throw new Error('box unreachable');
          return { boxTimeMs: 5_000_000, supportsPark: true, memory: { totalKb: 16_000_000, availableKb: 8_000_000 }, seats: [] };
        },
        sleepBotDesktop: async () => 'parked',
      },
    });
    scheduler.start();
    assert.equal(typeof scheduledCallback, 'function');

    scheduledCallback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /probe error: box unreachable/);

    boxReachable = true;
    scheduledCallback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 1);
    scheduler.stop();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

test('computer park overrides work with real d0a4baa host & runnerRegistry Map shape and protect background shell bots', async () => {
  const shellExecutions = [];
  const shellExecutorResource = Symbol('shellExecutor');
  class SandBoxNoMonitorAvailableError extends Error {}
  class SandBoxWindowError extends Error {}

  const runningDisplays = new Set();
  const overrides = createComputerParkOverrides({
    SAND_BOX_FIRST_FORK_WINDOW_INDEX: 2,
    SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE: 75,
    SandBoxNoMonitorAvailableError,
    isPrimaryWindowIndex: index => index === 1,
    reportHostDiagnostic: () => {},
    shellExecutorResource,
  });

  // Note: buildHostShellArgs and SandBoxWindowError are NOT in bindings at LoopbackSandBox construction time!
  const bindings = {};
  class FakeLoopbackSandBox {
    constructor() {
      this.windowConnections = new Map();
    }
    async ensureReady() {
      return { remoteAccessor: accessor, vncUrl: 'http://box:6080/vnc.html', terminalsFolder: '/tmp' };
    }
    async ensureWindow(ctx, boxId, windowIndex, opts) {
      const key = bindings.sandBoxWindowKey(boxId, windowIndex);
      if (this.windowConnections.has(key) && runningDisplays.has(windowIndex)) {
        return this.windowConnections.get(key);
      }
      await bindings.runStartWindow(ctx, accessor, windowIndex, opts.ownerToken);
      const win = { windowIndex, computerUse: accessor, vncUrl: `http://box:6081/?token=${windowIndex}` };
      this.windowConnections.set(key, win);
      return win;
    }
  }
  overrides.LoopbackSandBox(FakeLoopbackSandBox, bindings);
  bindings.buildHostShellArgs = args => args;
  bindings.SandBoxWindowError = SandBoxWindowError;
  bindings.sandBoxWindowKey = (agentId, windowIndex) => `${agentId}#${windowIndex}`;
  bindings.runStartWindow = overrides.runStartWindow(() => {}, bindings);
  bindings.runStopWindow = overrides.runStopWindow(() => {}, bindings);

  const accessor = {
    get(resource) {
      assert.equal(resource, shellExecutorResource);
      return {
        async execute(_ctx, args) {
          shellExecutions.push(args);
          if (args.name === 'start-window') {
            const match = /start-window (\d+)/.exec(args.command);
            runningDisplays.add(Number(match[1]));
            return { result: { case: 'success', value: { exitCode: 0, stdout: '', stderr: '' } } };
          }
          if (args.name === 'desktop-probe') {
            const lines = ['clock\t2000000', 'cap\t1', 'mem\t16000000\t8000000', 'psi\t0.00'];
            for (const n of [2, 3, 4]) {
              if (args.command.includes('for d in')) {
                const up = runningDisplays.has(n) ? 1 : 0;
                lines.push(`seat\t${n}\t${up}\t${up}\t0\t0\t1990000`);
              }
            }
            return { result: { case: 'success', value: { exitCode: 0, stdout: lines.join('\n'), stderr: '' } } };
          }
          if (args.name === 'park-seat') {
            const match = /stop-window --park (\d+)/.exec(args.command);
            const win = Number(match[1]);
            if (!runningDisplays.has(win)) {
              return { result: { case: 'success', value: { exitCode: 0, stdout: 'GROKBOT_PARK_STATUS=not-running\n', stderr: '' } } };
            }
            runningDisplays.delete(win);
            return { result: { case: 'success', value: { exitCode: 0, stdout: 'GROKBOT_PARK_STATUS=parked\n', stderr: '' } } };
          }
          if (args.name === 'stop-window') {
            return { result: { case: 'success', value: { exitCode: 0, stdout: '', stderr: '' } } };
          }
          throw new Error(`Unexpected shell command: ${args.name}`);
        },
      };
    },
  };

  class FakeSharedDesktopSandBox {
    constructor(inner) {
      this.inner = inner;
      this.sharedBoxId = 'shared';
      this.agentWindows = new Map();
      this.agentWindowTokens = new Map();
      this.establishedForks = new Set();
      this.inheritedForks = new Set();
    }
    async ensureAssignmentsLoaded() {}
    async ensureReady(ctx, agentId) {
      let win = this.agentWindows.get(agentId);
      if (!win) {
        win = this.agentWindows.size + 2;
        this.agentWindows.set(agentId, win);
        this.agentWindowTokens.set(agentId, `tok_${agentId}`);
      }
      const w = await this.inner.ensureWindow(ctx, this.sharedBoxId, win, {
        ownerToken: this.agentWindowTokens.get(agentId),
      });
      this.establishedForks.add(agentId);
      return { remoteAccessor: w.computerUse, vncUrl: w.vncUrl };
    }
    async releaseWindow() {}
  }
  overrides.SharedDesktopSandBox(FakeSharedDesktopSandBox);

  const shared = new FakeSharedDesktopSandBox(new FakeLoopbackSandBox());
  const wrappedHostBox = { inner: shared };

  // Even with 0 seats, collectForkSeatSnapshots reads the Box clock (never Host Date.now())
  const emptySnap = await shared.collectForkSeatSnapshots({});
  assert.equal(emptySnap.boxTimeMs, 2000000 * 1000);
  assert.deepEqual(emptySnap.seats, []);

  // Start three bot Fork desktops (:2 for botA, :3 for botB, :4 for botC)
  await shared.ensureReady({}, 'botA');
  await shared.ensureReady({}, 'botB');
  await shared.ensureReady({}, 'botC');
  assert.deepEqual([...runningDisplays].sort(), [2, 3, 4]);

  // Real d0a4baa host shape: NO host.transcript/session, and runnerRegistry.runners is a Map keyed by Bot ID (no runner.agentId)
  const startupLogs = [];
  const realShapeHost = {
    log: message => startupLogs.push(message),
    events: {},
    isIdle: () => true,
    whenBackgroundWorkReady: async () => {},
  };
  const transcriptApi = {
    runLifecycle: { runningAgentIds: () => new Set() },
    runnerRegistry: {
      runners: new Map([
        ['botA', { getConversationId: () => 'conv-a', hasRunningBackgroundShellWork: () => false }],
        ['botC', { getConversationId: () => 'conv-c', hasRunningBackgroundShellWork: () => true }],
      ]),
    },
  };
  const sessionApi = { pendingHandoff: id => (id === 'botB' ? { requestId: 'h1' } : null) };
  const autoReview = () => ({ agentIdsWithPendingApprovals: () => [] });

  assert.deepEqual(
    [...collectLiveAgentIds({ host: realShapeHost, transcript: () => transcriptApi, autoReview, session: () => sessionApi, desktops: shared })].sort(),
    ['botB', 'botC'],
  );

  // Default disabled: startLocalIdleDesktopPark returns null
  assert.equal(
    startLocalIdleDesktopPark({
      context: { onStop: () => {} },
      host: realShapeHost,
      library: { createContext: () => ({ withCancel: () => [{}, () => {}] }) },
      foreverBox: { box: wrappedHostBox },
      transcript: () => transcriptApi,
      autoReview,
      session: () => sessionApi,
      env: {},
    }),
    null,
  );

  let stopHook;
  const scheduler = startLocalIdleDesktopPark({
    context: { onStop: fn => { stopHook = fn; } },
    host: realShapeHost,
    library: { createContext: () => ({ withCancel: () => [{ withName() { return this; } }, () => {}] }) },
    foreverBox: { box: wrappedHostBox },
    transcript: () => transcriptApi,
    autoReview,
    session: () => sessionApi,
    env: { GROKBOT_DESKTOP_PARK_ENABLED: '1', GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '1', GROKBOT_DESKTOP_PARK_INTERVAL_MS: '600000' },
  });
  assert.ok(scheduler);
  assert.ok(startupLogs.some(line => line.includes('[grokbot-park] enabled:')));

  // First cycle initializes bootBaselineMs; second cycle 2m later parks botA (:2) while keeping botB (:3, handoff) & botC (:4, bg shell)
  await scheduler.runCycle();
  const origSnapshot = shared.collectForkSeatSnapshots.bind(shared);
  shared.collectForkSeatSnapshots = async ctx => {
    const snap = await origSnapshot(ctx);
    return { ...snap, boxTimeMs: snap.boxTimeMs + 2 * 60_000 };
  };
  const tickResult = await scheduler.runCycle();
  assert.equal(tickResult.status, 'completed');
  assert.equal(tickResult.actions.length, 1);
  assert.equal(tickResult.actions[0].agentId, 'botA');
  assert.equal(tickResult.actions[0].outcome, 'parked');
  assert.deepEqual([...runningDisplays].sort(), [3, 4]);
  assert.equal(shared.inner.windowConnections.has('shared#2'), false);

  // Next ensureReady on botA transparently re-runs start-window on :2 and restores connection
  const startCallsBefore = shellExecutions.filter(item => item.name === 'start-window').length;
  await shared.ensureReady({}, 'botA');
  const startCallsAfter = shellExecutions.filter(item => item.name === 'start-window').length;
  assert.equal(startCallsAfter, startCallsBefore + 1);
  assert.deepEqual([...runningDisplays].sort(), [2, 3, 4]);
  assert.equal(BOX_CONTRACT.firstForkDisplay, 2);
  stopHook?.();
});

test('SharedDesktopSandBox.serializeBotDesktopOp preserves mutual exclusion when a middle queued request is canceled', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const overrides = createComputerParkOverrides({
      SAND_BOX_FIRST_FORK_WINDOW_INDEX: 2,
      SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE: 75,
      SandBoxNoMonitorAvailableError: class extends Error {},
      isPrimaryWindowIndex: index => index === 1,
      reportHostDiagnostic: () => {},
      shellExecutorResource: Symbol('shell'),
    });

    let releaseBlockingPark;
    let parkStartedResolve;
    const parkStarted = new Promise(resolve => {
      parkStartedResolve = resolve;
    });
    let activeCount = 0;
    let maxConcurrency = 0;
    let ensureCalls = 0;
    let failEnsure = true;
    let failPark = true;

    class FakeSharedDesktopSandBox {
      constructor() {
        this.sharedBoxId = 'shared';
        this.agentWindows = new Map([['botA', 2]]);
        this.agentWindowTokens = new Map([['botA', 'tok_a']]);
        this.inner = {
          evictForkDisplay: async () => {
            if (releaseBlockingPark === 'wait') {
              activeCount += 1;
              maxConcurrency = Math.max(maxConcurrency, activeCount);
              parkStartedResolve();
              await new Promise(resolve => {
                releaseBlockingPark = resolve;
              });
              activeCount -= 1;
              return 'parked';
            }
            if (failPark) throw new Error('transient box park failure');
            return 'parked';
          },
        };
      }
      async ensureAssignmentsLoaded() {}
      async ensureReady() {
        activeCount += 1;
        maxConcurrency = Math.max(maxConcurrency, activeCount);
        try {
          ensureCalls += 1;
          if (failEnsure) throw new Error('transient box ensure failure');
          await new Promise(resolve => setImmediate(resolve));
          return { ok: true };
        } finally {
          activeCount -= 1;
        }
      }
      async releaseWindow() {}
    }
    overrides.SharedDesktopSandBox(FakeSharedDesktopSandBox);
    const shared = new FakeSharedDesktopSandBox();

    await assert.rejects(() => shared.ensureReady({}, 'botA'), /transient box ensure failure/);
    await assert.rejects(() => shared.sleepBotDesktop({}, 'botA', { minIdleSeconds: 1800 }), /transient box park failure/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);

    releaseBlockingPark = 'wait';
    const blockingPark = shared.sleepBotDesktop({}, 'botA', { minIdleSeconds: 1800 });
    await parkStarted;

    failEnsure = false;
    const callsBeforeAbort = ensureCalls;
    const ac = new AbortController();
    const canceledMiddle = shared.ensureReady({ signal: ac.signal }, 'botA');
    const trailingThird = shared.ensureReady({}, 'botA');

    ac.abort(new Error('turn cancelled'));
    await assert.rejects(() => canceledMiddle, /turn cancelled/);

    // Trailing request MUST still be waiting while blockingPark holds the mutex!
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ensureCalls, callsBeforeAbort);
    assert.equal(maxConcurrency, 1);

    releaseBlockingPark?.();
    assert.equal(await blockingPark, 'parked');
    assert.deepEqual(await trailingThird, { ok: true });
    assert.equal(ensureCalls, callsBeforeAbort + 1);
    assert.equal(maxConcurrency, 1);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shared._botDesktopQueues.size, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('createComputerParkOverrides degrades safely when original dependencies are missing', () => {
  const warnings = [];
  const overrides = createComputerParkOverrides({ isPrimaryWindowIndex: i => i === 1 }, message => warnings.push(message));
  assert.deepEqual(overrides, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing original computer dependencies/);
});

test('resolveSharedDesktopBox skips unwrapped non-multi-window box and logs when enabled', () => {
  const logs = [];
  const plainBox = { ensureReady: async () => {} };
  assert.equal(resolveSharedDesktopBox(plainBox), undefined);
  assert.equal(
    startLocalIdleDesktopPark({
      host: { log: msg => logs.push(msg) },
      library: { createContext: () => ({ withCancel: () => [{}, () => {}] }) },
      foreverBox: { box: plainBox },
      env: { GROKBOT_DESKTOP_PARK_ENABLED: '1' },
    }),
    null,
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /shared execution desktop or host context is unavailable/);
});

const hostSeedDir = process.env.PROKBOT_TEST_HOST_SEED ?? '';

test(
  'installRecoveredComputer installs park overrides only when GROKBOT_DESKTOP_PARK_ENABLED=1 on generated Host seed',
  { skip: !hostSeedDir && 'set PROKBOT_TEST_HOST_SEED to run the pinned Computer/Box recovery integration test' },
  async t => {
    const relDir = path.join(hostSeedDir, 'release-reliability');
    const moduleDir = existsSync(relDir) ? relDir : hostSeedDir;
    const require = createRequire(import.meta.url);
    const candidate = existsSync(path.join(relDir, 'host-library-reliable.cjs'))
      ? path.join(relDir, 'host-library-reliable.cjs')
      : path.join(hostSeedDir, 'host-library.cjs');
    let library;
    try {
      library = require(candidate);
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND') {
        t.skip(`skipping Host seed integration test (${error.message.split('\n')[0]})`);
        return;
      }
      throw error;
    }

    const makeMockLibrary = () => {
      const orig = library.getComputerRecoveryBindings();
      let installedBindings;
      return {
        computerRecoveryPlan: library.computerRecoveryPlan,
        getComputerRecoveryBindings: () => orig,
        installRecoveredComputer: bindings => {
          installedBindings = bindings;
          return bindings;
        },
        getInstalled: () => installedBindings,
      };
    };

    // Disabled by default -> SharedDesktopSandBox has NO sleepBotDesktop
    const disabledLib = makeMockLibrary();
    await installRecoveredComputer(disabledLib, moduleDir, {});
    assert.equal(typeof disabledLib.getInstalled().SharedDesktopSandBox.prototype.sleepBotDesktop, 'undefined');

    // Enabled -> SharedDesktopSandBox gets sleepBotDesktop & collectForkSeatSnapshots
    const enabledLib = makeMockLibrary();
    await installRecoveredComputer(enabledLib, moduleDir, { GROKBOT_DESKTOP_PARK_ENABLED: '1' });
    assert.equal(typeof enabledLib.getInstalled().SharedDesktopSandBox.prototype.sleepBotDesktop, 'function');
    assert.equal(typeof enabledLib.getInstalled().SharedDesktopSandBox.prototype.collectForkSeatSnapshots, 'function');
  },
);

test('compose files forward all GROKBOT_DESKTOP_PARK_* variables to Host container', () => {
  const envVars = [
    'GROKBOT_DESKTOP_PARK_ENABLED',
    'GROKBOT_DESKTOP_PARK_IDLE_MINUTES',
    'GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES',
    'GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT',
    'GROKBOT_DESKTOP_PARK_PRESSURE_PSI',
    'GROKBOT_DESKTOP_PARK_MAX_PER_TICK',
    'GROKBOT_DESKTOP_PARK_INTERVAL_MS',
  ];
  for (const name of ['compose.yaml', 'compose.host.yaml']) {
    const text = readFileSync(new URL(`../release/${name}`, import.meta.url), 'utf8');
    for (const envVar of envVars) {
      assert.match(text, new RegExp(`${envVar}:\\s*\\$\\{${envVar}:-\\}`), `${name} missing ${envVar}`);
    }
  }
});
