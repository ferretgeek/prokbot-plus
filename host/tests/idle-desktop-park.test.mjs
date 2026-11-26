import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DESKTOP_PARK_CONFIG,
  IDLE_DESKTOP_PARK_INTERVAL_MS,
  MIN_DESKTOP_PARK_INTERVAL_MS,
  SAND_BOX_WINDOW_IN_USE_EXIT_CODE,
  SAND_BOX_WINDOW_NOT_RUNNING_EXIT_CODE,
  SAND_BOX_WINDOW_PARK_UNSUPPORTED_EXIT_CODE,
  SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE,
  UNPARKED_BACKOFF_BASE_MS,
  UNSUPPORTED_PARK_PAUSE_MS,
  collectLiveAgentIds,
  createComputerParkOverrides,
  createIdleDesktopPark,
  decideDesktopParks,
  desktopActivityCommand,
  isUnderMemoryPressure,
  lockedStartWindowCommand,
  lockedStopWindowCommand,
  parkWindowCommand,
  parksToRelievePressure,
  parseDesktopActivity,
  readDesktopParkConfig,
  readDesktopParkIntervalMs,
  resolveSharedDesktopBox,
  startLocalIdleDesktopPark,
} from '../runtime/idle-desktop-park.mjs';
import { installRecoveredComputer } from '../runtime/recovered-computer.mjs';

test('readDesktopParkConfig defaults to disabled and honors valid env overrides', () => {
  assert.equal(DEFAULT_DESKTOP_PARK_CONFIG.enabled, false);
  assert.deepEqual(readDesktopParkConfig({}), DEFAULT_DESKTOP_PARK_CONFIG);
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

  // Malformed or out-of-range values fall back cleanly without parseInt truncation
  const fallback = readDesktopParkConfig({
    GROKBOT_DESKTOP_PARK_ENABLED: 'maybe',
    GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '-5',
    GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES: '1.5',
    GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT: '105',
    GROKBOT_DESKTOP_PARK_PRESSURE_PSI: '12px',
    GROKBOT_DESKTOP_PARK_MAX_PER_TICK: '30s',
  });
  assert.deepEqual(fallback, DEFAULT_DESKTOP_PARK_CONFIG);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '1.5' }), IDLE_DESKTOP_PARK_INTERVAL_MS);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '60s' }), IDLE_DESKTOP_PARK_INTERVAL_MS);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '5000' }), IDLE_DESKTOP_PARK_INTERVAL_MS);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: String(MIN_DESKTOP_PARK_INTERVAL_MS) }), 10_000);
  assert.equal(readDesktopParkIntervalMs({ GROKBOT_DESKTOP_PARK_INTERVAL_MS: '15000' }), 15_000);
});

test('decideDesktopParks parks >30m idle forks and skips primary, stopped, VNC-viewed, and live agents', () => {
  const startMs = 1_000_000;
  const nowMs = startMs + 45 * 60_000;
  const plan = decideDesktopParks({
    nowMs,
    idleClockStartMs: startMs,
    liveAgentIds: new Set(['agent-live']),
    memory: { totalKb: 16 * 1024 * 1024, availableKb: 10 * 1024 * 1024, psiSomeAvg10: 0 },
    seats: [
      { agentId: 'agent-primary', windowIndex: 1, running: true, lastUsedAtMs: startMs - 60_000, viewerAttached: false },
      { agentId: 'agent-stopped', windowIndex: 2, running: false, lastUsedAtMs: startMs - 60_000, viewerAttached: false },
      { agentId: 'agent-vnc', windowIndex: 3, running: true, lastUsedAtMs: startMs - 60_000, viewerAttached: true },
      { agentId: 'agent-live', windowIndex: 4, running: true, lastUsedAtMs: startMs - 60_000, viewerAttached: false },
      { agentId: 'agent-recent', windowIndex: 5, running: true, lastUsedAtMs: nowMs - 10 * 60_000, viewerAttached: false },
      { agentId: 'agent-idle-a', windowIndex: 7, running: true, lastUsedAtMs: nowMs - 31 * 60_000, viewerAttached: false },
      { agentId: 'agent-idle-b', windowIndex: 6, running: true, lastUsedAtMs: nowMs - 40 * 60_000, viewerAttached: false },
    ],
  });

  assert.equal(plan.underPressure, false);
  assert.deepEqual(
    plan.parks.map(entry => ({ agentId: entry.agentId, windowIndex: entry.windowIndex, reason: entry.reason, minIdleSeconds: entry.minIdleSeconds })),
    [
      { agentId: 'agent-idle-b', windowIndex: 6, reason: 'idle', minIdleSeconds: 1800 },
      { agentId: 'agent-idle-a', windowIndex: 7, reason: 'idle', minIdleSeconds: 1800 },
    ],
  );
});

test('decideDesktopParks evicts >=5m idle forks under MemAvailable or PSI memory pressure', () => {
  const startMs = 1_000_000;
  const nowMs = startMs + 20 * 60_000;
  const totalKb = 16 * 1024 * 1024; // 16 GiB -> 15% target is ~2.4 GiB
  const availableKb = 1.5 * 1024 * 1024; // shortfall ~921 MiB -> needs ceil(921 / 400) = 3 parks
  assert.equal(isUnderMemoryPressure({ totalKb, availableKb, psiSomeAvg10: 0 }), true);
  assert.equal(parksToRelievePressure({ totalKb, availableKb, psiSomeAvg10: 0 }), 3);
  assert.equal(isUnderMemoryPressure({ totalKb, availableKb: 8 * 1024 * 1024, psiSomeAvg10: 12.4 }), true);
  assert.equal(parksToRelievePressure({ totalKb, availableKb: 8 * 1024 * 1024, psiSomeAvg10: 12.4 }), 1);

  const plan = decideDesktopParks({
    nowMs,
    idleClockStartMs: startMs,
    liveAgentIds: new Set(),
    memory: { totalKb, availableKb, psiSomeAvg10: 0 },
    seats: [
      { agentId: 'too-fresh', windowIndex: 2, running: true, lastUsedAtMs: nowMs - 2 * 60_000, viewerAttached: false },
      { agentId: 'lru-1', windowIndex: 3, running: true, lastUsedAtMs: nowMs - 18 * 60_000, viewerAttached: false },
      { agentId: 'lru-2', windowIndex: 4, running: true, lastUsedAtMs: nowMs - 12 * 60_000, viewerAttached: false },
      { agentId: 'lru-3', windowIndex: 5, running: true, lastUsedAtMs: nowMs - 7 * 60_000, viewerAttached: false },
      { agentId: 'lru-4', windowIndex: 6, running: true, lastUsedAtMs: nowMs - 6 * 60_000, viewerAttached: false },
    ],
  });

  assert.equal(plan.underPressure, true);
  assert.deepEqual(
    plan.parks.map(entry => ({ agentId: entry.agentId, reason: entry.reason, minIdleSeconds: entry.minIdleSeconds })),
    [
      { agentId: 'lru-1', reason: 'pressure', minIdleSeconds: 300 },
      { agentId: 'lru-2', reason: 'pressure', minIdleSeconds: 300 },
      { agentId: 'lru-3', reason: 'pressure', minIdleSeconds: 300 },
    ],
  );
});

test('window commands wrap timeouts and pdeathsig, close flock fd 9, and parse activity output', () => {
  assert.throws(() => parkWindowCommand(1, 'valid-token', { idleSeconds: 1800 }), /Invalid fork window index/);
  assert.throws(() => parkWindowCommand(2, 'bad token; rm -rf /', { idleSeconds: 1800 }), /malformed owner token/);
  assert.throws(() => lockedStartWindowCommand(2, "bad'quote"), /malformed owner token/);

  const startCmd = lockedStartWindowCommand(17, 'token_abc-123');
  assert.match(startCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(startCmd, /flock -w 70 9/);
  assert.match(startCmd, /setpriv --pdeathsig KILL \/usr\/local\/bin\/start-window 17 '\\''token_abc-123'\\'' 9>&-/);
  assert.match(startCmd, /touch \/tmp\/sand-window-locks\.d\/17\.ensured/);

  const stopCmd = lockedStopWindowCommand(17);
  assert.match(stopCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(stopCmd, /setpriv --pdeathsig KILL \/usr\/local\/bin\/stop-window 17 9>&-/);

  const parkCmd = parkWindowCommand(17, 'token_abc-123', { idleSeconds: 1800 });
  assert.match(parkCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(parkCmd, /flock -n 9/);
  assert.match(parkCmd, /setpriv --pdeathsig KILL \/usr\/local\/bin\/stop-window --park 17 9>&-/);
  assert.match(parkCmd, /sport = :5917/);
  assert.match(parkCmd, /sport = :14017/);

  const actCmd = desktopActivityCommand([1, 2, 17]);
  assert.match(actCmd, /^timeout -k 5 150 \/bin\/sh -c '/);
  assert.match(actCmd, /for n in 2 17; do/);

  const parsed = parseDesktopActivity(
    [
      'now 1795622853',
      'mem 16133452 3000000',
      'psi 4.25',
      'w 2 1 1795620000 1795621000 0',
      'w 17 0 0 0 1',
      'w 99 1 1795622000 1795622000 0',
    ].join('\n'),
    [2, 17],
  );
  assert.deepEqual(parsed, {
    nowMs: 1795622853 * 1000,
    memory: { totalKb: 16133452, availableKb: 3000000, psiSomeAvg10: 4.25 },
    windows: [
      { windowIndex: 2, running: true, lastUsedAtMs: 1795621000 * 1000, viewerAttached: false },
      { windowIndex: 17, running: false, lastUsedAtMs: undefined, viewerAttached: true },
    ],
  });
});

test('createIdleDesktopPark handles backoff (not cleared by not-running), roster-pending logs, and unsupported pause', async () => {
  let monoMs = 10_000;
  let boxNowMs = 1_000_000;
  let outcomes = ['not-running'];
  let rosterReady = false;
  const calls = [];
  const logs = [];

  const parker = createIdleDesktopPark({
    ctx: {},
    clock: { monotonicNow: () => monoMs },
    intervalMs: 60_000,
    readConfig: () => ({ ...DEFAULT_DESKTOP_PARK_CONFIG, enabled: true }),
    liveAgentIds: () => (rosterReady ? new Set() : undefined),
    log: message => logs.push(message),
    desktops: {
      snapshotForkDesktops: async () => ({
        nowMs: boxNowMs,
        memory: { totalKb: 16_000_000, availableKb: 8_000_000, psiSomeAvg10: 0 },
        seats: [{ agentId: 'a1', windowIndex: 2, running: true, lastUsedAtMs: boxNowMs - 40 * 60_000, viewerAttached: false }],
      }),
      parkAgentWindow: async (_ctx, agentId, opts) => {
        calls.push({ agentId, opts });
        return outcomes.shift() ?? 'parked';
      },
    },
  });

  // Repeated roster-pending ticks emit a single diagnostic once threshold is reached
  assert.equal((await parker.tick()).kind, 'roster-pending');
  assert.equal((await parker.tick()).kind, 'roster-pending');
  assert.equal((await parker.tick()).kind, 'roster-pending');
  assert.equal(logs.filter(line => line.includes('waiting for transcript roster')).length, 1);
  rosterReady = true;

  // First ticked run initializes idleClockStartMs
  let res = await parker.tick();
  assert.equal(res.results.length, 0);

  // Advance 31 minutes -> parks a1, receives 'not-running' -> STILL enters 5m backoff (only 'parked' clears backoff)
  monoMs += 31 * 60_000;
  boxNowMs += 31 * 60_000;
  res = await parker.tick();
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].outcome, 'not-running');

  monoMs += 60_000;
  boxNowMs += 60_000;
  res = await parker.tick();
  assert.equal(res.results.length, 0);

  // Past 5m backoff -> retried; if box reports 'unsupported', pauses for UNSUPPORTED_PARK_PAUSE_MS
  outcomes = ['unsupported'];
  monoMs += UNPARKED_BACKOFF_BASE_MS;
  boxNowMs += UNPARKED_BACKOFF_BASE_MS;
  res = await parker.tick();
  assert.equal(res.results[0].outcome, 'unsupported');

  monoMs += 60_000;
  boxNowMs += 60_000;
  res = await parker.tick();
  assert.equal(res.kind, 'unsupported');

  monoMs += UNSUPPORTED_PARK_PAUSE_MS;
  boxNowMs += UNSUPPORTED_PARK_PAUSE_MS;
  outcomes = ['parked'];
  res = await parker.tick();
  assert.equal(res.kind, 'ticked');
  assert.equal(res.results[0].outcome, 'parked');
});

test('computer park overrides work with real host shape (no host.transcript/session) and protect active/background bots', async () => {
  const shellExecutions = [];
  const shellExecutorResource = Symbol('shellExecutor');
  class SandBoxNoMonitorAvailableError extends Error {}
  class SandBoxWindowError extends Error {}

  const runningDisplays = new Set();
  const overrides = createComputerParkOverrides({
    SAND_BOX_FIRST_FORK_WINDOW_INDEX: 2,
    SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE,
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
  // Populated later in recovery order, proving lazy lookup works
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
          if (args.name === 'desktop-activity') {
            const lines = ['now 2000000', 'mem 16000000 8000000', 'psi 0.00'];
            for (const n of [2, 3, 4]) {
              if (args.command.includes('for n in')) {
                lines.push(`w ${n} ${runningDisplays.has(n) ? 1 : 0} 1990000 1990000 0`);
              }
            }
            return { result: { case: 'success', value: { exitCode: 0, stdout: lines.join('\n'), stderr: '' } } };
          }
          if (args.name === 'park-window') {
            const match = /stop-window --park (\d+)/.exec(args.command);
            const win = Number(match[1]);
            if (!runningDisplays.has(win)) {
              return { result: { case: 'failure', value: { aborted: false, exitCode: SAND_BOX_WINDOW_NOT_RUNNING_EXIT_CODE, stderr: '' } } };
            }
            runningDisplays.delete(win);
            return { result: { case: 'success', value: { exitCode: 0, stdout: `sand window ${win} parked\n`, stderr: '' } } };
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

  // Even with 0 seats, snapshotForkDesktops reads the Box clock (never Host Date.now())
  const emptySnap = await shared.snapshotForkDesktops({});
  assert.equal(emptySnap.nowMs, 2000000 * 1000);
  assert.deepEqual(emptySnap.seats, []);

  // Start three bot Fork desktops (:2 for botA, :3 for botB, :4 for botC)
  await shared.ensureReady({}, 'botA');
  await shared.ensureReady({}, 'botB');
  await shared.ensureReady({}, 'botC');
  assert.deepEqual([...runningDisplays].sort(), [2, 3, 4]);

  // Real d0a4baa host shape: NO host.transcript and NO host.session!
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
      values: () => [
        { agentId: 'botC', hasRunningBackgroundShellWork: () => true },
      ],
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
  const parker = startLocalIdleDesktopPark({
    context: { onStop: fn => { stopHook = fn; } },
    host: realShapeHost,
    library: { createContext: () => ({ withCancel: () => [{ withName() { return this; } }, () => {}] }) },
    foreverBox: { box: wrappedHostBox },
    transcript: () => transcriptApi,
    autoReview,
    session: () => sessionApi,
    env: { GROKBOT_DESKTOP_PARK_ENABLED: '1', GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '1', GROKBOT_DESKTOP_PARK_INTERVAL_MS: '600000' },
  });
  assert.ok(parker);
  assert.ok(startupLogs.some(line => line.includes('idle desktop park enabled:')));

  // Snapshot initializes idleClockStartMs, then second snapshot 2m later parks botA (:2) while keeping botB (:3, handoff) & botC (:4, bg shell)
  await parker.tick();
  const origSnapshot = shared.snapshotForkDesktops.bind(shared);
  shared.snapshotForkDesktops = async ctx => {
    const snap = await origSnapshot(ctx);
    return { ...snap, nowMs: snap.nowMs + 2 * 60_000 };
  };
  const tickResult = await parker.tick();
  assert.equal(tickResult.kind, 'ticked');
  assert.equal(tickResult.results.length, 1);
  assert.equal(tickResult.results[0].agentId, 'botA');
  assert.equal(tickResult.results[0].outcome, 'parked');
  assert.deepEqual([...runningDisplays].sort(), [3, 4]);
  assert.equal(shared.inner.windowConnections.has('shared#2'), false);

  // Next ensureReady on botA transparently re-runs start-window on :2 and restores connection
  const startCallsBefore = shellExecutions.filter(item => item.name === 'start-window').length;
  await shared.ensureReady({}, 'botA');
  const startCallsAfter = shellExecutions.filter(item => item.name === 'start-window').length;
  assert.equal(startCallsAfter, startCallsBefore + 1);
  assert.deepEqual([...runningDisplays].sort(), [2, 3, 4]);

  assert.equal(SAND_BOX_WINDOW_PARK_UNSUPPORTED_EXIT_CODE, 74);
  assert.equal(SAND_BOX_WINDOW_IN_USE_EXIT_CODE, 78);
  stopHook?.();
});

test('SharedDesktopSandBox.inAgentQueue supports ctx.signal cancellation and stays healthy on errors', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const overrides = createComputerParkOverrides({
      SAND_BOX_FIRST_FORK_WINDOW_INDEX: 2,
      SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE,
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
    let ensureCalls = 0;
    let failEnsure = true;
    let failPark = true;

    class FakeSharedDesktopSandBox {
      constructor() {
        this.sharedBoxId = 'shared';
        this.agentWindows = new Map([['botA', 2]]);
        this.agentWindowTokens = new Map([['botA', 'tok_a']]);
        this.inner = {
          parkWindow: async () => {
            if (releaseBlockingPark === 'wait') {
              parkStartedResolve();
              await new Promise(resolve => {
                releaseBlockingPark = resolve;
              });
              return 'parked';
            }
            if (failPark) throw new Error('transient box park failure');
            return 'parked';
          },
        };
      }
      async ensureAssignmentsLoaded() {}
      async ensureReady() {
        ensureCalls += 1;
        if (failEnsure) throw new Error('transient box ensure failure');
        return { ok: true };
      }
      async releaseWindow() {}
    }
    overrides.SharedDesktopSandBox(FakeSharedDesktopSandBox);
    const shared = new FakeSharedDesktopSandBox();

    await assert.rejects(() => shared.ensureReady({}, 'botA'), /transient box ensure failure/);
    await assert.rejects(() => shared.parkAgentWindow({}, 'botA', { minIdleSeconds: 1800 }), /transient box park failure/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);

    // Aborting ctx.signal while queued rejects immediately without running the queued ensureReady
    releaseBlockingPark = 'wait';
    const blockingPark = shared.parkAgentWindow({}, 'botA', { minIdleSeconds: 1800 });
    await parkStarted;

    failEnsure = false;
    const callsBeforeAbort = ensureCalls;
    const ac = new AbortController();
    const queuedEnsure = shared.ensureReady({ signal: ac.signal }, 'botA');
    ac.abort(new Error('turn cancelled'));
    await assert.rejects(() => queuedEnsure, /turn cancelled/);

    releaseBlockingPark?.();
    assert.equal(await blockingPark, 'parked');
    assert.equal(ensureCalls, callsBeforeAbort);
    assert.deepEqual(await shared.ensureReady({}, 'botA'), { ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shared._agentParkQueues.size, 0);
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

test('resolveSharedDesktopBox skips unwrapped non-multi-window box', () => {
  const plainBox = { ensureReady: async () => {} };
  assert.equal(resolveSharedDesktopBox(plainBox), undefined);
  assert.equal(
    startLocalIdleDesktopPark({
      host: {},
      library: { createContext: () => ({ withCancel: () => [{}, () => {}] }) },
      foreverBox: { box: plainBox },
      env: { GROKBOT_DESKTOP_PARK_ENABLED: '1' },
    }),
    null,
  );
});

test('installRecoveredComputer installs park overrides only when GROKBOT_DESKTOP_PARK_ENABLED=1 on pinned Host archive', async t => {
  const configured = process.env.PROKBOT_TEST_HOST_ARCHIVE;
  const archivePath = configured || path.resolve(import.meta.dirname, '../../inputs/host/sand-host-bundle-d0a4baa.tgz');
  if (!existsSync(archivePath)) {
    t.skip('set PROKBOT_TEST_HOST_ARCHIVE to run the pinned Computer/Box recovery integration test');
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'park-host-seed-'));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const preparedDir = path.join(tmpDir, 'prepared');
  execFileSync('python3', [
    path.resolve(import.meta.dirname, '../release/patch-host.py'),
    '--archive',
    archivePath,
    '--output',
    preparedDir,
  ]);

  const seedDir = path.join(preparedDir, 'seed', 'release-reliability');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const library = require(path.join(preparedDir, 'seed', 'host-library.cjs'));

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

  // Disabled by default -> SharedDesktopSandBox has NO parkAgentWindow
  const disabledLib = makeMockLibrary();
  await installRecoveredComputer(disabledLib, seedDir, {});
  assert.equal(typeof disabledLib.getInstalled().SharedDesktopSandBox.prototype.parkAgentWindow, 'undefined');

  // Enabled -> SharedDesktopSandBox gets parkAgentWindow & snapshotForkDesktops
  const enabledLib = makeMockLibrary();
  await installRecoveredComputer(enabledLib, seedDir, { GROKBOT_DESKTOP_PARK_ENABLED: '1' });
  assert.equal(typeof enabledLib.getInstalled().SharedDesktopSandBox.prototype.parkAgentWindow, 'function');
  assert.equal(typeof enabledLib.getInstalled().SharedDesktopSandBox.prototype.snapshotForkDesktops, 'function');
});

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
