import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOSING_SEND_NUDGE_PROMPT,
  MAX_CLOSING_SEND_NUDGES,
  THINKING_ACTIVITY,
  createSendToUserVisibilityReminder,
  detectSilentToolCallEnding,
  hasTrailingNonDeliveryToolResult,
  hasVisibilityReminderSinceLastWork,
  wrapActionHandler,
  wrapAnysphereAgent,
  wrapCreateTurnSettle,
  wrapResolveNamedActivityHold,
  wrapRunLifecycle,
  wrapTurnRuntime,
} from '../runtime/turn-continuity.mjs';
import { createHarnessModelErrorMapper } from '../runtime/model-errors.mjs';
import { ModelRequestError } from '../runtime/model-session.mjs';
import { constructRecoveredHostFlow } from '../runtime/recovered-host-flow.mjs';
import { constructRecoveredEngine } from '../runtime/recovered-engine.mjs';
import { constructRecoveredHarness } from '../runtime/recovered-harness.mjs';
import { installRecoveredHostExecutionAndSession } from '../runtime/recovered-host-execution.mjs';

const toolCall = (toolName, toolCallId) => ({ type: 'tool-call', toolName, toolCallId, args: {} });
const toolResult = (toolName, toolCallId, { isError = false } = {}) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolName, toolCallId, result: isError ? 'err' : 'ok', ...(isError ? { isError: true } : {}) }],
  providerOptions: { cursor: { highLevelToolCallResult: { isError } } },
});

test('detectSilentToolCallEnding catches multi-SendToUser, tool-first, parallel, and plain-text/reasoning silent endings', () => {
  // Multi-progress SendToUser followed by MCP write tools, ending on tool results.
  const multiAckToolEnd = [
    { role: 'user', content: 'Permission granted, try creating the issue and comment now.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('GetMcpTools', 'mcp-1')] },
    toolResult('GetMcpTools', 'mcp-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-2')] },
    toolResult('SendToUser', 'send-2'),
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-2')] },
    toolResult('CallMcpTool', 'mcp-2'),
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-3')] },
    toolResult('CallMcpTool', 'mcp-3'),
  ];
  assert.equal(detectSilentToolCallEnding(multiAckToolEnd), true);

  // Same turn ending on reasoning-only assistant step (no text, no tool call).
  assert.equal(detectSilentToolCallEnding([
    ...multiAckToolEnd,
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Both operations succeeded.' }] },
  ]), true);

  // Same turn ending on invisible plain assistant text (forgot SendToUser).
  assert.equal(detectSilentToolCallEnding([
    ...multiAckToolEnd,
    { role: 'assistant', content: [{ type: 'text', text: 'Issue #1 and comment were created.' }] },
  ]), true);

  // Tool call before first SendToUser, then more tools and silent stop.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Check and apply the fix.' },
    { role: 'assistant', content: [toolCall('BoxRead', 'read-1')] },
    toolResult('BoxRead', 'read-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
  ]), true);

  // Parallel [SendToUser, CallMcpTool] in the same assistant message.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Run it now.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1'), toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('SendToUser', 'send-1'),
    toolResult('CallMcpTool', 'mcp-1'),
  ]), true);

  // Failed closing SendToUser after work still requires closing delivery.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Do the work.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-2')] },
    toolResult('SendToUser', 'send-2', { isError: true }),
  ]), true);

  // Injected reminder messages do not reset the turn boundary.
  assert.equal(detectSilentToolCallEnding([
    ...multiAckToolEnd,
    {
      role: 'user',
      content: '<system_reminder>Please continue. Respond to the user or make tool calls.</system_reminder>',
      providerOptions: { cursor: { sandEarlyResultReminder: true } },
    },
    { role: 'assistant', content: '' },
  ]), true);
});

test('detectSilentToolCallEnding stays false for properly delivered, status-only, or zero-delivery turns', () => {
  // Normal completed turn: work followed by final SendToUser and wrap-up/blank text.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Create issue.' },
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('CallMcpTool', 'mcp-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]), false);

  // Only SetStatus after final SendToUser is not unreported work.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Update me.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('SetStatus', 'st-1')] },
    toolResult('SetStatus', 'st-1'),
  ]), false);

  // Zero deliveries on a normal user turn is handled by REPLY_NUDGE_PROMPT, not closing nudge.
  const zeroDelivery = [
    { role: 'user', content: 'Run check.' },
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
  ];
  assert.equal(detectSilentToolCallEnding(zeroDelivery), false);
  // On a closing-nudge turn (requirePriorDelivery: false), running tools without delivery DOES re-trigger.
  assert.equal(detectSilentToolCallEnding(zeroDelivery, { requirePriorDelivery: false }), true);
  // A closing nudge that produced neither tools nor delivery stops immediately (no spin).
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: CLOSING_SEND_NUDGE_PROMPT },
    { role: 'assistant', content: [{ type: 'text', text: 'Unable to send.' }] },
  ], { requirePriorDelivery: false }), false);
});

test('hasTrailingNonDeliveryToolResult and hasVisibilityReminderSinceLastWork track latest tool work accurately', () => {
  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('CallMcpTool', 'mcp-1'),
  ]), true);

  // Trailing injected reminder after a work tool result still sees the work tool.
  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
    {
      role: 'user',
      content: '<system_reminder>\nYou have made several tool calls without a SendToUser, so the user is currently watching silence.\n</system_reminder>',
    },
  ]), true);

  // Trailing successful SendToUser returns false so normal completion does not retry.
  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('CallMcpTool', 'mcp-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
  ]), false);

  // Failed SendToUser returns true so the step can recover.
  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1', { isError: true }),
  ]), true);

  // Visibility reminder suppresses back-to-back retries, but resets after new tool work.
  const reminder = createSendToUserVisibilityReminder(() => ({ providerOptions: { cursor: { projectSendMessageReminder: true } } }));
  assert.match(reminder.content, /SendToUser/);
  assert.equal(hasVisibilityReminderSinceLastWork([
    { role: 'user', content: 'Go.' },
    reminder,
  ]), true);
  assert.equal(hasVisibilityReminderSinceLastWork([
    { role: 'user', content: 'Go.' },
    reminder,
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-2')] },
    toolResult('CallMcpTool', 'mcp-2'),
  ]), false);
});

test('wrapActionHandler masks prior SendToUser during post-tool steps and restores turn cleanly even on throw', async () => {
  const observed = [];
  class FakeActionHandler {
    async runStep(_ctx, turn) {
      observed.push(turn.hasSendMessageCall());
      return { ok: true };
    }
    async runModelOnlyStep(_ctx, turn) {
      observed.push(turn.hasSendMessageCall());
      throw new Error('EmptyResponseRetryError');
    }
  }
  wrapActionHandler(FakeActionHandler);
  const handler = new FakeActionHandler();
  class Turn {
    hasSendMessageCall() { return true; }
  }
  const turn = new Turn();

  // After non-delivery tool result: masked to false during step, restored after.
  await handler.runStep({}, turn, {
    getMessages: () => [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
      toolResult('SendToUser', 'send-1'),
      { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
      toolResult('CallMcpTool', 'mcp-1'),
    ],
  });
  assert.equal(observed.at(-1), false);
  assert.equal(turn.hasSendMessageCall(), true);
  assert.equal(Object.hasOwn(turn, 'hasSendMessageCall'), false);

  // Also restores when step throws (e.g. EmptyResponseRetryError).
  await assert.rejects(() => handler.runModelOnlyStep({}, turn, {
    getMessages: () => [
      { role: 'user', content: 'Go.' },
      toolResult('BoxShell', 'sh-1'),
    ],
  }), /EmptyResponseRetryError/);
  assert.equal(observed.at(-1), false);
  assert.equal(turn.hasSendMessageCall(), true);

  // After successful SendToUser tool result: NOT masked.
  await handler.runStep({}, turn, {
    getMessages: () => [
      { role: 'user', content: 'Go.' },
      toolResult('SendToUser', 'send-1'),
    ],
  });
  assert.equal(observed.at(-1), true);
});

test('wrapAnysphereAgent defaults enableEmptyResponseRetry to true while respecting explicit false', () => {
  class FakeAgent {
    constructor(config, extra) {
      this.config = config;
      this.extra = extra;
    }
  }
  const Wrapped = wrapAnysphereAgent(FakeAgent);

  const originalConfig = { modelId: 'test', featureFlags: { userMessageTimestamps: true } };
  const agent = new Wrapped(originalConfig, 'tag');
  assert.ok(agent instanceof FakeAgent);
  assert.equal(agent.config.featureFlags.enableEmptyResponseRetry, true);
  assert.equal(agent.config.featureFlags.userMessageTimestamps, true);
  assert.equal(originalConfig.featureFlags.enableEmptyResponseRetry, undefined);
  assert.equal(agent.extra, 'tag');

  const disabled = new Wrapped({ featureFlags: { enableEmptyResponseRetry: false } });
  assert.equal(disabled.config.featureFlags.enableEmptyResponseRetry, false);
});

test('wrapCreateTurnSettle and wrapTurnRuntime continue closing nudges up to MAX_CLOSING_SEND_NUDGES and stop cleanly', async () => {
  const createSettle = wrapCreateTurnSettle((host) => {
    let endedOnSilentToolCalls = false;
    return {
      async settleCompletedTurn(args) {
        if (!host.isSubagentRunner && !args.hidden) {
          endedOnSilentToolCalls = detectSilentToolCallEnding(host.latestPromptMessages());
        }
      },
      buildResult(flags) {
        return {
          sentMessageCount: 0,
          reacted: false,
          aborted: Boolean(flags.aborted),
          ...(endedOnSilentToolCalls ? { endedOnSilentToolCalls: true } : {}),
        };
      },
    };
  });

  // Hidden closing-send nudge that executed another tool silently sets endedOnSilentToolCalls.
  const nudgeSettle = createSettle({
    isSubagentRunner: false,
    latestPromptMessages: () => [
      { role: 'user', content: CLOSING_SEND_NUDGE_PROMPT },
      { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-verify')] },
      toolResult('CallMcpTool', 'mcp-verify'),
    ],
  }, {});
  await nudgeSettle.settleCompletedTurn({ hidden: true, trimmedPrompt: CLOSING_SEND_NUDGE_PROMPT });
  assert.equal(nudgeSettle.buildResult({ aborted: false }).endedOnSilentToolCalls, true);

  // Unrelated hidden automation turn does NOT set endedOnSilentToolCalls.
  const bgSettle = createSettle({
    isSubagentRunner: false,
    latestPromptMessages: () => [
      { role: 'user', content: 'Run scheduled maintenance.' },
      { role: 'assistant', content: [toolCall('SendToUser', 's-1')] },
      toolResult('SendToUser', 's-1'),
      { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
      toolResult('BoxShell', 'sh-1'),
    ],
  }, {});
  await bgSettle.settleCompletedTurn({ hidden: true, trimmedPrompt: 'Run scheduled maintenance.' });
  assert.equal(bgSettle.buildResult({ aborted: false }).endedOnSilentToolCalls, undefined);

  // Bounded closing-send nudge loop in TurnRuntime: recovers on 2nd closing nudge.
  class FakeTurnRuntime {
    constructor(tm) { this.tm = tm; }
    async ensureUserReply(runner, result) {
      let latest = result;
      if (latest.endedOnSilentToolCalls) {
        latest = await runner.run(CLOSING_SEND_NUDGE_PROMPT, { hidden: true });
      }
      return { result: latest, replyNudgeAttempts: 0, deliveryOwed: false, streamOutputProduced: true };
    }
  }
  wrapTurnRuntime(FakeTurnRuntime);

  const telemetryCalls = [];
  const runtime = new FakeTurnRuntime({
    sendPipeline: { currentTurnEpoch: () => 7 },
    telemetry: { reportClosingSendNudge: evt => telemetryCalls.push(evt) },
  });

  const runs = [
    { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true, streamOutputProduced: true },
    { sentMessageCount: 1, reacted: false, aborted: false, streamOutputProduced: true },
  ];
  let runCalls = 0;
  const runner = {
    run: async () => runs[runCalls++],
  };
  const settled = await runtime.ensureUserReply(
    runner,
    { sentMessageCount: 2, reacted: false, aborted: false, endedOnSilentToolCalls: true, streamOutputProduced: true },
    { id: 'bot-1' },
    7,
  );
  assert.equal(runCalls, 2);
  assert.equal(settled.result.sentMessageCount, 1);
  assert.equal(telemetryCalls.length, 1);
  assert.equal(telemetryCalls[0].delivered, true);

  // Never exceeds MAX_CLOSING_SEND_NUDGES even if every nudge ends silently.
  let capCalls = 0;
  const capped = await runtime.ensureUserReply(
    {
      run: async () => {
        capCalls += 1;
        return { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true };
      },
    },
    { sentMessageCount: 1, reacted: false, aborted: false, endedOnSilentToolCalls: true },
    { id: 'bot-1' },
    7,
  );
  assert.equal(capCalls, MAX_CLOSING_SEND_NUDGES);
  assert.equal(capped.result.endedOnSilentToolCalls, true);
});

test('RunLifecycle and resolveNamedActivityHold keep thinking activity visible at start and across mid-turn SendToUser', () => {
  const initialHold = { heldActivity: undefined, heldSinceMs: 0 };
  const originalResolve = (update, state) => {
    if (update.type === 'send-message' || update.type === 'turn-ended') {
      return { transition: { type: 'clear' }, state: initialHold };
    }
    return { transition: { type: 'keep' }, state };
  };
  const resolve = wrapResolveNamedActivityHold(originalResolve, initialHold);

  const midTurn = resolve({ type: 'send-message' }, { heldActivity: { kind: 'tool', tool: 'CallMcpTool' }, heldSinceMs: 10 }, 20, 2500);
  assert.deepEqual(midTurn, { transition: { type: 'set', activity: THINKING_ACTIVITY }, state: initialHold });

  const ended = resolve({ type: 'turn-ended' }, initialHold, 30, 2500);
  assert.deepEqual(ended, { transition: { type: 'clear' }, state: initialHold });

  const emittedActivities = [];
  class FakeRunLifecycle {
    inFlightRunCounts = new Map();
    sessionActivities = new Map();
    beginSessionRun(session) {
      const count = this.inFlightRunCounts.get(session) ?? 0;
      this.inFlightRunCounts.set(session, count + 1);
      emittedActivities.push(this.sessionActivities.get(session.id));
    }
  }
  wrapRunLifecycle(FakeRunLifecycle);
  const lifecycle = new FakeRunLifecycle();
  const session = { id: 'bot-a' };

  lifecycle.beginSessionRun(session);
  assert.deepEqual(emittedActivities, [THINKING_ACTIVITY]);

  // Nested beginSessionRun preserves existing tool activity.
  const toolActivity = { kind: 'tool', tool: 'CallMcpTool', callId: 'c-1' };
  lifecycle.sessionActivities.set('bot-a', toolActivity);
  lifecycle.beginSessionRun(session);
  assert.deepEqual(emittedActivities[1], toolActivity);
});

test('createHarnessModelErrorMapper maps length truncation to OutputTokensLimitExceededError when available', () => {
  class ConnectError extends Error {}
  class ActionRequiredError extends Error {}
  class NonRetriableError extends Error {}
  class OutputTokensLimitExceededError extends Error {
    constructor(message) { super(message); this.name = 'OutputTokensLimitExceededError'; }
  }
  const Code = { ResourceExhausted: 8, Unavailable: 14, Internal: 13 };

  const viaEngineBindings = createHarnessModelErrorMapper({
    ConnectError,
    ActionRequiredError,
    NonRetriableError,
    Code,
    getEngineRecoveryBindings: () => ({ OutputTokensLimitExceededError }),
  });
  const sourceError = new ModelRequestError('Model response stopped with max_tokens', { code: 'length' });
  const mapped = viaEngineBindings(sourceError);
  assert.ok(mapped instanceof OutputTokensLimitExceededError);
  assert.equal(mapped.cause, sourceError);

  const fallback = createHarnessModelErrorMapper({ ConnectError, ActionRequiredError, NonRetriableError, Code });
  assert.ok(fallback(sourceError) instanceof NonRetriableError);
});

test('recovered host-flow, engine, and harness constructors apply turn-continuity overrides end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prokbot-continuity-'));
  try {
    await writeFile(join(dir, 'flow.mjs'), `
      export function createRecoveredModule({ turnEndedOnSilentToolCalls }) {
        return {
          createTurnSettle(host) {
            let endedOnSilentToolCalls = false;
            return {
              async settleCompletedTurn(args) {
                if (!host.isSubagentRunner && !args.hidden) endedOnSilentToolCalls = turnEndedOnSilentToolCalls(host.latestPromptMessages());
              },
              buildResult() { return { endedOnSilentToolCalls }; },
            };
          },
        };
      }
    `);
    await writeFile(join(dir, 'engine.mjs'), `
      export function createRecoveredModule({ hasProjectSendMessageReminderForCurrentRequest, createProjectSendMessageVisibilityReminder }) {
        class AbstractUserMessageActionHandler {
          async runStep(_ctx, turn, executor) {
            return {
              hasSend: turn.hasSendMessageCall(),
              reminded: hasProjectSendMessageReminderForCurrentRequest(executor.getMessages()),
              reminderText: createProjectSendMessageVisibilityReminder().content,
            };
          }
        }
        return { AbstractUserMessageActionHandler };
      }
    `);
    await writeFile(join(dir, 'harness.mjs'), `
      export function createRecoveredModule({ AnysphereAgent }) {
        return {
          buildAgent() { return new AnysphereAgent({ featureFlags: { userMessageTimestamps: true } }); },
        };
      }
    `);

    const flow = await constructRecoveredHostFlow({
      hostFlowRecoveryPlan: {
        modules: [{ name: 'flow.mjs', dependencies: ['turnEndedOnSilentToolCalls'], recoveredDependencies: [], originalDependencies: ['turnEndedOnSilentToolCalls'], exports: ['createTurnSettle'] }],
      },
      getHostFlowRecoveryBindings: () => ({
        runTurnMemory: () => {},
        turnEndedOnSilentToolCalls: () => false,
      }),
    }, dir);
    const settle = flow.bindings.createTurnSettle({
      isSubagentRunner: false,
      latestPromptMessages: () => [
        { role: 'user', content: 'Write issue and comment.' },
        { role: 'assistant', content: [toolCall('SendToUser', 's1')] },
        toolResult('SendToUser', 's1'),
        { role: 'assistant', content: [toolCall('SendToUser', 's2')] },
        toolResult('SendToUser', 's2'),
        { role: 'assistant', content: [toolCall('CallMcpTool', 'm1')] },
        toolResult('CallMcpTool', 'm1'),
      ],
    }, {});
    await settle.settleCompletedTurn({ hidden: false, trimmedPrompt: 'Write issue and comment.' });
    assert.equal(settle.buildResult().endedOnSilentToolCalls, true);

    const engine = await constructRecoveredEngine({
      engineRecoveryPlan: {
        modules: [{
          name: 'engine.mjs',
          dependencies: ['hasProjectSendMessageReminderForCurrentRequest', 'createProjectSendMessageVisibilityReminder'],
          recoveredDependencies: [],
          originalDependencies: ['hasProjectSendMessageReminderForCurrentRequest', 'createProjectSendMessageVisibilityReminder'],
          exports: ['AbstractUserMessageActionHandler'],
        }],
      },
      getEngineRecoveryBindings: () => ({
        hasProjectSendMessageReminderForCurrentRequest: () => true,
        createProjectSendMessageVisibilityReminder: () => ({
          role: 'user',
          content: 'legacy SendMessage',
          providerOptions: { cursor: { projectSendMessageReminder: true } },
        }),
      }),
    }, dir);
    const handler = new engine.bindings.AbstractUserMessageActionHandler();
    const step = await handler.runStep({}, { hasSendMessageCall: () => true }, {
      getMessages: () => [
        { role: 'user', content: 'old', providerOptions: { cursor: { projectSendMessageReminder: true } } },
        toolResult('CallMcpTool', 'm2'),
      ],
    });
    assert.equal(step.hasSend, false);
    assert.equal(step.reminded, false);
    assert.match(step.reminderText, /SendToUser/);

    class BaseAgent { constructor(config) { this.config = config; } }
    const harness = await constructRecoveredHarness({
      harnessRecoveryPlan: {
        modules: [{ name: 'harness.mjs', dependencies: ['AnysphereAgent'], recoveredDependencies: [], originalDependencies: ['AnysphereAgent'], exports: ['buildAgent'] }],
      },
      getHarnessRecoveryBindings: () => ({ AnysphereAgent: BaseAgent }),
    }, dir);
    const built = harness.bindings.buildAgent();
    assert.ok(built instanceof BaseAgent);
    assert.equal(built.config.featureFlags.enableEmptyResponseRetry, true);

    await writeFile(join(dir, 'exec.mjs'), `
      export function createRecoveredModule({ resolveNamedActivityHold, INITIAL_NAMED_ACTIVITY_HOLD_STATE }) {
        class RunLifecycle {
          inFlightRunCounts = new Map();
          sessionActivities = new Map();
          beginSessionRun(session) {
            this.inFlightRunCounts.set(session, (this.inFlightRunCounts.get(session) ?? 0) + 1);
            return this.sessionActivities.get(session.id);
          }
          checkSendMessage() {
            return resolveNamedActivityHold({ type: 'send-message' }, INITIAL_NAMED_ACTIVITY_HOLD_STATE, 100, 2500);
          }
        }
        class TurnRuntime {
          constructor(tm) { this.tm = tm; }
          async ensureUserReply(runner, result) {
            const latest = result.endedOnSilentToolCalls ? await runner.run('first', { hidden: true }) : result;
            return { result: latest, replyNudgeAttempts: 0, deliveryOwed: false, streamOutputProduced: true };
          }
        }
        return { RunLifecycle, TurnRuntime };
      }
    `);
    await writeFile(join(dir, 'session.mjs'), `
      export function createRecoveredModule() {
        return { sessionMarker() { return 'ok'; } };
      }
    `);
    let installedExecution;
    const initialHold = { heldActivity: undefined, heldSinceMs: 0 };
    await installRecoveredHostExecutionAndSession({
      hostExecutionRecoveryPlan: {
        modules: [{
          name: 'exec.mjs',
          dependencies: ['resolveNamedActivityHold', 'INITIAL_NAMED_ACTIVITY_HOLD_STATE'],
          recoveredDependencies: [],
          originalDependencies: ['resolveNamedActivityHold', 'INITIAL_NAMED_ACTIVITY_HOLD_STATE'],
          exports: ['RunLifecycle', 'TurnRuntime'],
        }],
      },
      hostSessionRecoveryPlan: {
        modules: [{
          name: 'session.mjs',
          dependencies: [],
          recoveredDependencies: [],
          originalDependencies: [],
          exports: ['sessionMarker'],
        }],
      },
      getHostExecutionRecoveryBindings: () => ({
        SandAgentRunner: class {},
        INITIAL_NAMED_ACTIVITY_HOLD_STATE: initialHold,
        resolveNamedActivityHold: (update) => ({ transition: { type: update.type === 'turn-ended' ? 'clear' : 'keep' }, state: initialHold }),
      }),
      getHostSessionRecoveryBindings: () => ({}),
      installRecoveredHostSession: () => ['sessionMarker'],
      installRecoveredHostExecution: bindings => { installedExecution = bindings; return ['RunLifecycle', 'TurnRuntime']; },
    }, dir);
    const lifecycle = new installedExecution.RunLifecycle();
    assert.deepEqual(lifecycle.beginSessionRun({ id: 'bot-1' }), THINKING_ACTIVITY);
    assert.deepEqual(lifecycle.checkSendMessage().transition, { type: 'set', activity: THINKING_ACTIVITY });
    let execRuns = 0;
    const tr = new installedExecution.TurnRuntime({
      sendPipeline: { currentTurnEpoch: () => 1 },
      telemetry: { reportClosingSendNudge: () => {} },
    });
    const execSettled = await tr.ensureUserReply(
      {
        run: async () => {
          execRuns += 1;
          return execRuns === 1
            ? { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true }
            : { sentMessageCount: 1, reacted: false, aborted: false };
        },
      },
      { sentMessageCount: 2, reacted: false, aborted: false, endedOnSilentToolCalls: true },
      { id: 'bot-1' },
      1,
    );
    assert.equal(execRuns, 2);
    assert.equal(execSettled.result.sentMessageCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
