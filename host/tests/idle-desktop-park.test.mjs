import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_DESKTOP_PARK_CONFIG,
  IDLE_DESKTOP_PARK_INTERVAL_MS,
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

test('readDesktopParkConfig uses official 9d2ac1b defaults and honors valid env overrides', () => {
  assert.deepEqual(readDesktopParkConfig({}), DEFAULT_DESKTOP_PARK_CONFIG);
  assert.equal(readDesktopParkIntervalMs({}), 60_000);

  const custom = readDesktopParkConfig({
    GROKBOT_DESKTOP_PARK_ENABLED: 'false',
    GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '20',
    GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES: '3',
    GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT: '18.5',
    GROKBOT_DESKTOP_PARK_PRESSURE_PSI: '7.5',
    GROKBOT_DESKTOP_PARK_MAX_PER_TICK: '4',
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.idleMinutes, 20);
  assert.equal(custom.pressureIdleMinutes, 3);
  assert.equal(custom.pressureAvailablePercent, 18.5);
  assert.equal(custom.pressurePsiSomeAvg10, 7.5);
  assert.equal(custom.maxParksPerTick, 4);

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

test('window commands validate inputs, close flock fd 9 for children, and parse activity output', () => {
  assert.throws(() => parkWindowCommand(1, 'valid-token', { idleSeconds: 1800 }), /Invalid fork window index/);
  assert.throws(() => parkWindowCommand(2, 'bad token; rm -rf /', { idleSeconds: 1800 }), /malformed owner token/);
  assert.throws(() => lockedStartWindowCommand(2, "bad'quote"), /malformed owner token/);

  const startCmd = lockedStartWindowCommand(17, 'token_abc-123');
  assert.match(startCmd, /flock -w 70 9/);
  assert.match(startCmd, /\/usr\/local\/bin\/start-window 17 'token_abc-123' 9>&-/);
  assert.match(startCmd, /touch \/tmp\/sand-window-locks\.d\/17\.ensured/);

  const stopCmd = lockedStopWindowCommand(17);
  assert.match(stopCmd, /\/usr\/local\/bin\/stop-window 17 9>&-/);

  const parkCmd = parkWindowCommand(17, 'token_abc-123', { idleSeconds: 1800 });
  assert.match(parkCmd, /flock -n 9/);
  assert.match(parkCmd, /\/usr\/local\/bin\/stop-window --park 17 9>&-/);
  assert.match(parkCmd, /sport = :5917/);
  assert.match(parkCmd, /sport = :14017/);

  const actCmd = desktopActivityCommand([1, 2, 17]);
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

test('createIdleDesktopPark handles backoff on in-use and pauses on unsupported box', async () => {
  let monoMs = 10_000;
  let boxNowMs = 1_000_000;
  let outcomes = ['in-use'];
  const calls = [];

  const parker = createIdleDesktopPark({
    ctx: {},
    clock: { monotonicNow: () => monoMs },
    intervalMs: 60_000,
    readConfig: () => DEFAULT_DESKTOP_PARK_CONFIG,
    liveAgentIds: () => new Set(),
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

  // First tick: idle Clock initializes to boxNowMs; ttlIdleMs is 0 because idleClockStartMs clamps pre-boot idle
  let res = await parker.tick();
  assert.equal(res.results.length, 0);

  // Advance 31 minutes without clock jump -> parks a1, receives 'in-use' -> enters 5m backoff
  monoMs += 31 * 60_000;
  boxNowMs += 31 * 60_000;
  res = await parker.tick();
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].outcome, 'in-use');

  // 1 minute later -> still in 5m backoff, skipped
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

test('computer park overrides wire SharedDesktopSandBox park/wake cycle and protect handoff/approval agents', async () => {
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

  const bindings = {
    buildHostShellArgs: args => args,
    SandBoxWindowError,
    sandBoxWindowKey: (agentId, windowIndex) => `${agentId}#${windowIndex}`,
  };
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
            for (const n of [2, 3]) {
              lines.push(`w ${n} ${runningDisplays.has(n) ? 1 : 0} 1990000 1990000 0`);
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
  const applySharedDesktop = overrides.applySharedDesktop(inner => new FakeSharedDesktopSandBox(inner));

  const shared = applySharedDesktop(new FakeLoopbackSandBox());
  const wrappedHostBox = { inner: shared };

  // Start two bot Fork desktops (:2 for botA, :3 for botB)
  await shared.ensureReady({}, 'botA');
  await shared.ensureReady({}, 'botB');
  assert.deepEqual([...runningDisplays].sort(), [2, 3]);
  assert.equal(shared.inner.windowConnections.size, 2);

  // Suppose botB has an active handoff; botA is completely idle
  const host = {
    transcript: { liveRunningAgentIds: () => new Set() },
    session: { pendingHandoff: id => (id === 'botB' ? { requestId: 'h1' } : null) },
    log: () => {},
  };
  const autoReview = () => ({ agentIdsWithPendingApprovals: () => [] });
  assert.deepEqual([...collectLiveAgentIds({ host, autoReview, desktops: shared })], ['botB']);

  let stopHook;
  const parker = startLocalIdleDesktopPark({
    context: { onStop: fn => { stopHook = fn; } },
    host,
    library: { createContext: () => ({ withCancel: () => [{ withName() { return this; } }, () => {}] }) },
    foreverBox: { box: wrappedHostBox },
    autoReview,
    env: { GROKBOT_DESKTOP_PARK_IDLE_MINUTES: '1', GROKBOT_DESKTOP_PARK_INTERVAL_MS: '600000' },
  });
  assert.ok(parker);

  // Snapshot initializes idleClockStartMs, then second snapshot 2m later parks botA (:2) while keeping botB (:3)
  await parker.tick();
  const origSnapshot = shared.snapshotForkDesktops.bind(shared);
  shared.snapshotForkDesktops = async ctx => {
    const snap = await origSnapshot(ctx);
    return { ...snap, nowMs: snap.nowMs + 2 * 60_000 };
  };
  const tickResult = await parker.tick();
  assert.equal(tickResult.results.length, 1);
  assert.equal(tickResult.results[0].agentId, 'botA');
  assert.equal(tickResult.results[0].outcome, 'parked');
  assert.deepEqual([...runningDisplays], [3]);
  assert.equal(shared.inner.windowConnections.has('shared#2'), false);

  // Next ensureReady on botA transparently re-runs start-window on :2 and restores connection
  const startCallsBefore = shellExecutions.filter(item => item.name === 'start-window').length;
  await shared.ensureReady({}, 'botA');
  const startCallsAfter = shellExecutions.filter(item => item.name === 'start-window').length;
  assert.equal(startCallsAfter, startCallsBefore + 1);
  assert.deepEqual([...runningDisplays].sort(), [2, 3]);

  assert.equal(SAND_BOX_WINDOW_PARK_UNSUPPORTED_EXIT_CODE, 74);
  assert.equal(SAND_BOX_WINDOW_IN_USE_EXIT_CODE, 78);
  stopHook?.();
});

test('SharedDesktopSandBox.inAgentQueue does not emit unhandledRejection on task failures and keeps queue healthy', async () => {
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

    let failEnsure = true;
    let failPark = true;
    class FakeSharedDesktopSandBox {
      constructor() {
        this.sharedBoxId = 'shared';
        this.agentWindows = new Map([['botA', 2]]);
        this.agentWindowTokens = new Map([['botA', 'tok_a']]);
        this.inner = {
          parkWindow: async () => {
            if (failPark) throw new Error('transient box park failure');
            return 'parked';
          },
        };
      }
      async ensureAssignmentsLoaded() {}
      async ensureReady() {
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

    failEnsure = false;
    failPark = false;
    assert.deepEqual(await shared.ensureReady({}, 'botA'), { ok: true });
    assert.equal(await shared.parkAgentWindow({}, 'botA', { minIdleSeconds: 1800 }), 'parked');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shared._agentParkQueues.size, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('resolveSharedDesktopBox skips unwrapped non-multi-window box and collectLiveAgentIds supports runLifecycle and session API', () => {
  const overrides = createComputerParkOverrides({
    SAND_BOX_FIRST_FORK_WINDOW_INDEX: 2,
    SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE,
    SandBoxNoMonitorAvailableError: class extends Error {},
    isPrimaryWindowIndex: index => index === 1,
    reportHostDiagnostic: () => {},
    shellExecutorResource: Symbol('shell'),
  });
  const applySharedDesktop = overrides.applySharedDesktop(box => box);
  const plainBox = { ensureReady: async () => {} };
  const result = applySharedDesktop(plainBox);
  assert.equal(result, plainBox);
  assert.equal(resolveSharedDesktopBox(result), undefined);
  assert.equal(
    startLocalIdleDesktopPark({
      host: {},
      library: { createContext: () => ({ withCancel: () => [{}, () => {}] }) },
      foreverBox: { box: result },
    }),
    null,
  );

  const desktops = { agentWindows: new Map([['botA', 2], ['botB', 3], ['botC', 4]]) };
  const live = collectLiveAgentIds({
    host: {
      transcript: {
        runLifecycle: {
          runningAgentIds: () => new Set(['botA']),
        },
      },
    },
    autoReview: () => ({ agentIdsWithPendingApprovals: () => ['botB'] }),
    session: () => ({ pendingHandoff: id => (id === 'botC' ? { requestId: 'h1' } : undefined) }),
    desktops,
  });
  assert.deepEqual([...live].sort(), ['botA', 'botB', 'botC']);

  const extensionsSource = readFileSync(new URL('../runtime/host-extensions.mjs', import.meta.url), 'utf8');
  assert.match(extensionsSource, /session:\s*\(\)\s*=>\s*apis\.get\('session'\)/);
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
