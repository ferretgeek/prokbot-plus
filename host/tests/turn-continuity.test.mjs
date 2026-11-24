import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOSING_SEND_NUDGE_PROMPT,
  MAX_CLOSING_SEND_NUDGES,
  MAX_EMPTY_RESPONSE_RETRIES_PER_TURN,
  MAX_OUTPUT_TOKEN_RETRIES_PER_STEP,
  MAX_VISIBILITY_REMINDERS_PER_TURN,
  THINKING_ACTIVITY,
  createSendToUserVisibilityReminder,
  detectSilentToolCallEnding,
  hasTrailingNonDeliveryToolResult,
  hasVisibilityReminderSinceLastWork,
  isClosingSendNudgePrompt,
  wrapActionHandler,
  wrapAnysphereAgent,
  wrapCreateTurnAgentComposition,
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
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';

const toolCall = (toolName, toolCallId) => ({ type: 'tool-call', toolName, toolCallId, args: {} });
const toolResult = (toolName, toolCallId, { isError = false } = {}) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolName, toolCallId, result: isError ? 'err' : 'ok', ...(isError ? { isError: true } : {}) }],
  providerOptions: { cursor: { highLevelToolCallResult: { isError } } },
});

test('detectSilentToolCallEnding catches multi-SendToUser, tool-first, parallel, and plain-text/reasoning silent endings', () => {
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

  assert.equal(detectSilentToolCallEnding([
    ...multiAckToolEnd,
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Both operations succeeded.' }] },
  ]), true);

  assert.equal(detectSilentToolCallEnding([
    ...multiAckToolEnd,
    { role: 'assistant', content: [{ type: 'text', text: 'Issue #1 and comment were created.' }] },
  ]), true);

  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Check and apply the fix.' },
    { role: 'assistant', content: [toolCall('BoxRead', 'read-1')] },
    toolResult('BoxRead', 'read-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
  ]), true);

  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Run it now.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1'), toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('SendToUser', 'send-1'),
    toolResult('CallMcpTool', 'mcp-1'),
  ]), true);

  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Do the work.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-2')] },
    toolResult('SendToUser', 'send-2', { isError: true }),
  ]), true);

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

test('detectSilentToolCallEnding excludes bookkeeping tools (update_state, TodoWrite, SetStatus) after delivery while keeping earlier silent work flagged', () => {
  // Sequential: SendToUser followed by update_state (e.g. "remember I like coffee").
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Remember that I like coffee.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('update_state', 'state-1')] },
    toolResult('update_state', 'state-1'),
  ]), false);

  // Parallel: [SendToUser, update_state] in the same assistant step.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Remember that I like coffee.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1'), toolCall('update_state', 'state-1')] },
    toolResult('SendToUser', 'send-1'),
    toolResult('update_state', 'state-1'),
  ]), false);

  // TodoWrite / todo_write / SetStatus after SendToUser also stay false.
  for (const toolName of ['TodoWrite', 'todo_write', 'SetStatus']) {
    assert.equal(detectSilentToolCallEnding([
      { role: 'user', content: 'Finish task.' },
      { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
      toolResult('SendToUser', 'send-1'),
      { role: 'assistant', content: [toolCall(toolName, 'bk-1')] },
      toolResult(toolName, 'bk-1'),
    ]), false);
    assert.equal(detectSilentToolCallEnding([
      { role: 'user', content: 'Finish task.' },
      { role: 'assistant', content: [toolCall('SendToUser', 'send-1'), toolCall(toolName, 'bk-2')] },
      toolResult('SendToUser', 'send-1'),
      toolResult(toolName, 'bk-2'),
    ]), false);
  }

  // Substantive work followed by update_state without a closing SendToUser is STILL silent work.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Check logs and remember what failed.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('Shell', 'sh-1')] },
    toolResult('Shell', 'sh-1'),
    { role: 'assistant', content: [toolCall('update_state', 'state-1')] },
    toolResult('update_state', 'state-1'),
  ]), true);

  // Normal completed turn and zero-delivery turns stay false.
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: 'Create issue.' },
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('CallMcpTool', 'mcp-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]), false);

  const zeroDelivery = [
    { role: 'user', content: 'Run check.' },
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
  ];
  assert.equal(detectSilentToolCallEnding(zeroDelivery), false);
  assert.equal(detectSilentToolCallEnding(zeroDelivery, { requirePriorDelivery: false }), true);
  assert.equal(detectSilentToolCallEnding([
    { role: 'user', content: CLOSING_SEND_NUDGE_PROMPT },
    { role: 'assistant', content: [{ type: 'text', text: 'Unable to send.' }] },
  ], { requirePriorDelivery: false }), false);
});

test('CLOSING_SEND_NUDGE_PROMPT forbids repeating already-delivered replies and matches both original and rewritten prompts', () => {
  assert.doesNotMatch(CLOSING_SEND_NUDGE_PROMPT, /opening acknowledgement/i);
  assert.match(CLOSING_SEND_NUDGE_PROMPT, /Do NOT repeat results you already sent earlier/);
  assert.equal(isClosingSendNudgePrompt(CLOSING_SEND_NUDGE_PROMPT), true);
  assert.equal(
    isClosingSendNudgePrompt(
      'Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendToUser — the last thing the user saw is that opening acknowledgement.',
    ),
    true,
  );
  assert.equal(isClosingSendNudgePrompt('unrelated prompt'), false);
});

test('hasTrailingNonDeliveryToolResult and hasVisibilityReminderSinceLastWork track tool results and cap per-turn reminders', () => {
  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('CallMcpTool', 'mcp-1'),
  ]), true);

  // Bookkeeping tools after SendToUser do NOT mask delivery.
  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Remember this.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
    { role: 'assistant', content: [toolCall('update_state', 'st-1')] },
    toolResult('update_state', 'st-1'),
  ]), false);

  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('BoxShell', 'sh-1')] },
    toolResult('BoxShell', 'sh-1'),
    {
      role: 'user',
      content: '<system_reminder>\nYou have made several tool calls without a SendToUser, so the user is currently watching silence.\n</system_reminder>',
    },
  ]), true);

  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
    toolResult('CallMcpTool', 'mcp-1'),
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1'),
  ]), false);

  assert.equal(hasTrailingNonDeliveryToolResult([
    { role: 'user', content: 'Go.' },
    { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
    toolResult('SendToUser', 'send-1', { isError: true }),
  ]), true);

  // Visibility reminder suppresses back-to-back retries, resets after substantive tool work,
  // and stops once MAX_VISIBILITY_REMINDERS_PER_TURN (2) have been injected in the turn.
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
  // Bookkeeping tool alone does not reset a pending visibility reminder.
  assert.equal(hasVisibilityReminderSinceLastWork([
    { role: 'user', content: 'Go.' },
    reminder,
    { role: 'assistant', content: [toolCall('update_state', 'st-2')] },
    toolResult('update_state', 'st-2'),
  ]), true);
  // Once MAX_VISIBILITY_REMINDERS_PER_TURN reminders occurred in this turn, further tool work stays suppressed.
  assert.equal(hasVisibilityReminderSinceLastWork([
    { role: 'user', content: 'Go.' },
    reminder,
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-2')] },
    toolResult('CallMcpTool', 'mcp-2'),
    reminder,
    { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-3')] },
    toolResult('CallMcpTool', 'mcp-3'),
  ]), true);
  assert.equal(MAX_VISIBILITY_REMINDERS_PER_TURN, 2);
});

test('wrapActionHandler avoids full-history unwrapping, bounds empty/length retries, and preserves truncation message', async () => {
  const observed = [];
  const unwrapCalls = [];
  class FakeActionHandler {
    async runStep(_ctx, turn, _exec, debug) {
      observed.push({ hasSend: turn.hasSendMessageCall(), debug });
      if (turn.throwOutputLimit) {
        const err = new Error('Model response stopped with max_tokens');
        err.name = 'OutputTokensLimitExceededError';
        err.cause = new ModelRequestError('Model response stopped with max_tokens', { code: 'length' });
        throw err;
      }
      return { ok: true };
    }
    async runModelOnlyStep(_ctx, turn) {
      observed.push({ hasSend: turn.hasSendMessageCall() });
      throw new Error('EmptyResponseRetryError');
    }
    async runWithMaxTokensRetry(parentCtx, _rootPromptExecutor, fn, emptyResponseRetryTurnBudget) {
      for (let i = 0; i < 5; i++) {
        try {
          return await fn(parentCtx, {
            outputTokenLimitRetryCount: i,
            emptyResponseRetryTurnBudget,
          });
        } catch (error) {
          if (error?.name === 'OutputTokensLimitExceededError') continue;
          throw error;
        }
      }
      const exhausted = new Error('Failed to run step, exceeded max retries');
      exhausted.name = 'StepRetriesExhaustedError';
      throw exhausted;
    }
  }

  class FakeNonRetriableError extends Error {
    constructor(message, options) { super(message, { cause: options?.cause }); this.displayInfo = options?.displayInfo; }
  }
  wrapActionHandler(FakeActionHandler, {
    fromRedactedCoreMessages: msgs => {
      unwrapCalls.push(msgs.length);
      return msgs;
    },
    PrivacyCapability: { UNSAFE_ALWAYS_ALLOWED: 'unsafe' },
    NonRetriableError: FakeNonRetriableError,
  });
  const handler = new FakeActionHandler();
  class Turn {
    constructor(hasSend, throwOutputLimit = false) {
      this._hasSend = hasSend;
      this.throwOutputLimit = throwOutputLimit;
    }
    hasSendMessageCall() { return this._hasSend; }
  }

  // When hasSendMessageCall() is false, getMessages()/fromRedactedCoreMessages is skipped completely.
  let getMessagesCalled = false;
  await handler.runStep({}, new Turn(false), {
    getMessages: () => {
      getMessagesCalled = true;
      return [{ role: 'user', content: 'Hi' }];
    },
  });
  assert.equal(getMessagesCalled, false);
  assert.equal(unwrapCalls.length, 0);

  // When hasSendMessageCall() is true, only the trailing non-assistant slice is unwrapped.
  const sendTurn = new Turn(true);
  await handler.runStep({}, sendTurn, {
    getMessages: () => [
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: [toolCall('BoxShell', 'sh-0')] },
      toolResult('BoxShell', 'sh-0'),
      { role: 'assistant', content: [toolCall('SendToUser', 'send-1')] },
      toolResult('SendToUser', 'send-1'),
      { role: 'assistant', content: [toolCall('CallMcpTool', 'mcp-1')] },
      toolResult('CallMcpTool', 'mcp-1'),
    ],
  });
  assert.equal(observed.at(-1).hasSend, false);
  assert.deepEqual(unwrapCalls, [1]);
  assert.equal(sendTurn.hasSendMessageCall(), true);
  assert.equal(Object.hasOwn(sendTurn, 'hasSendMessageCall'), false);

  // Restores cleanly on throw from runModelOnlyStep.
  await assert.rejects(() => handler.runModelOnlyStep({}, sendTurn, {
    getMessages: () => [{ role: 'user', content: 'Go.' }, toolResult('BoxShell', 'sh-1')],
  }), /EmptyResponseRetryError/);
  assert.equal(observed.at(-1).hasSend, false);
  assert.equal(sendTurn.hasSendMessageCall(), true);

  // Empty response budget >= MAX_EMPTY_RESPONSE_RETRIES_PER_TURN (2) sets didRetryAfterEmptyResponse: true.
  assert.equal(MAX_EMPTY_RESPONSE_RETRIES_PER_TURN, 2);
  await handler.runWithMaxTokensRetry(
    {},
    { getMessages: () => [] },
    (_ctx, debug) => { observed.push({ debug }); return { ok: true }; },
    { retriesUsed: MAX_EMPTY_RESPONSE_RETRIES_PER_TURN },
  );
  assert.equal(observed.at(-1).debug.didRetryAfterEmptyResponse, true);

  // OutputTokensLimitExceededError is retried once (2 calls in the step); the next truncation
  // stops before a request would end with the partial reply, keeping the truncation message.
  assert.equal(MAX_OUTPUT_TOKEN_RETRIES_PER_STEP, 1);
  let truncationCalls = 0;
  await assert.rejects(
    () => handler.runWithMaxTokensRetry(
      {},
      { getMessages: () => [] },
      (ctx, debug) => {
        truncationCalls += 1;
        return handler.runStep(ctx, new Turn(false, true), { getMessages: () => [] }, debug);
      },
      { retriesUsed: 0 },
    ),
    error => {
      assert.match(error.message, /max_tokens/);
      assert.match(error.message, /1 continuation retry:/);
      assert.notEqual(error.name, 'StepRetriesExhaustedError');
      // Terminal, so the Runner does not retry the turn with the partial reply last in the history.
      assert.ok(error instanceof FakeNonRetriableError);
      assert.equal(error.displayInfo.isRetryable, false);
      assert.equal(error.cause?.code, 'length');
      return true;
    },
  );
  assert.equal(truncationCalls, MAX_OUTPUT_TOKEN_RETRIES_PER_STEP + 1);
});

test('wrapCreateTurnAgentComposition + wrapAnysphereAgent enable empty-response retry ONLY for normal user turns', () => {
  class FakeAgent {
    constructor(config, extra) {
      this.config = config;
      this.extra = extra;
    }
  }
  const ScopedAgent = wrapAnysphereAgent(FakeAgent);

  // Direct construction outside buildAgentForRun does not force enableEmptyResponseRetry.
  const direct = new ScopedAgent({ featureFlags: { userMessageTimestamps: true } }, 'tag');
  assert.equal(direct.config.featureFlags.enableEmptyResponseRetry, undefined);

  const createComposition = wrapCreateTurnAgentComposition(host => ({
    buildAgentForRun(_sessions, _box, turnScope) {
      return new ScopedAgent({
        featureFlags: {
          userMessageTimestamps: true,
          ...(turnScope?.explicit !== undefined ? { enableEmptyResponseRetry: turnScope.explicit } : {}),
        },
        hostFlag: host.isSubagentRunner,
        silenceFlag: turnScope?.isSilenceAllowed,
        groupFlag: turnScope?.isGroupMemberTurn,
      });
    },
  }));

  // Normal user turn -> enabled.
  const userComp = createComposition({ isSubagentRunner: false });
  const normalAgent = userComp.buildAgentForRun({}, {}, { isSilenceAllowed: false, isGroupMemberTurn: false });
  assert.equal(normalAgent.config.featureFlags.enableEmptyResponseRetry, true);
  assert.equal(normalAgent.config.featureFlags.userMessageTimestamps, true);

  // Subagent -> disabled.
  const subagentComp = createComposition({ isSubagentRunner: true });
  assert.equal(subagentComp.buildAgentForRun({}, {}, { isSilenceAllowed: false, isGroupMemberTurn: false }).config.featureFlags.enableEmptyResponseRetry, false);

  // isSilenceAllowed (cron / background wake / broadcast) -> disabled.
  assert.equal(userComp.buildAgentForRun({}, {}, { isSilenceAllowed: true, isGroupMemberTurn: false }).config.featureFlags.enableEmptyResponseRetry, false);

  // Group chat member turn -> disabled.
  assert.equal(userComp.buildAgentForRun({}, {}, { isSilenceAllowed: false, isGroupMemberTurn: true }).config.featureFlags.enableEmptyResponseRetry, false);

  // Explicit caller flag is respected.
  assert.equal(userComp.buildAgentForRun({}, {}, { explicit: false }).config.featureFlags.enableEmptyResponseRetry, false);
});

test('wrapCreateTurnSettle and wrapTurnRuntime bound closing nudges, rewrite prompt, and stamp sand.closing_send_nudge', async () => {
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

  const ORIGINAL_CLOSING_PROMPT =
    'Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendToUser — the last thing the user saw is that opening acknowledgement.';
  const REPLY_NUDGE_PROMPT = 'You never called SendToUser that turn.';
  const traceCalls = [];
  const setTurnTraceAttributes = (trace, attrs) => traceCalls.push({ trace, attrs });

  class FakeTurnRuntime {
    constructor(tm) { this.tm = tm; }
    async ensureUserReply(runner, result, _session, _epoch, _ackToken, _traceCtx, turnTrace) {
      let latest = result;
      let attempts = 0;
      while (latest.sentMessageCount === 0 && !latest.reacted && attempts < 2) {
        attempts += 1;
        latest = await runner.run(REPLY_NUDGE_PROMPT, { hidden: true });
      }
      if (latest.endedOnSilentToolCalls === true) {
        setTurnTraceAttributes(turnTrace, { 'sand.closing_send_nudge': true });
        latest = await runner.run(ORIGINAL_CLOSING_PROMPT, { hidden: true });
      }
      return { result: latest, replyNudgeAttempts: attempts, deliveryOwed: false, streamOutputProduced: true };
    }
  }
  wrapTurnRuntime(FakeTurnRuntime, { setTurnTraceAttributes });

  const telemetryCalls = [];
  const runtime = new FakeTurnRuntime({
    sendPipeline: { currentTurnEpoch: () => 7 },
    telemetry: { reportClosingSendNudge: evt => telemetryCalls.push(evt) },
  });

  // Recovers on 2nd closing nudge; both closing nudges use rewritten prompt and stamp trace attribute.
  const seenPrompts = [];
  const runs = [
    { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true, streamOutputProduced: true },
    { sentMessageCount: 1, reacted: false, aborted: false, streamOutputProduced: true },
  ];
  const turnTrace = { id: 'trace-1' };
  const settled = await runtime.ensureUserReply(
    {
      run: async prompt => {
        seenPrompts.push(prompt);
        return runs.shift();
      },
    },
    { sentMessageCount: 2, reacted: false, aborted: false, endedOnSilentToolCalls: true, streamOutputProduced: true },
    { id: 'bot-1' },
    7,
    undefined,
    undefined,
    turnTrace,
  );
  assert.deepEqual(seenPrompts, [CLOSING_SEND_NUDGE_PROMPT, CLOSING_SEND_NUDGE_PROMPT]);
  assert.equal(settled.result.sentMessageCount, 1);
  assert.equal(telemetryCalls.length, 1);
  assert.equal(traceCalls.length, 2);
  assert.deepEqual(traceCalls.map(c => c.attrs), [
    { 'sand.closing_send_nudge': true },
    { 'sand.closing_send_nudge': true },
  ]);

  // Never exceeds MAX_CLOSING_SEND_NUDGES (2) even if every nudge ends silently.
  assert.equal(MAX_CLOSING_SEND_NUDGES, 2);
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
  const resolveHold = wrapResolveNamedActivityHold(originalResolve, initialHold);

  const midTurn = resolveHold({ type: 'send-message' }, { heldActivity: { kind: 'tool', tool: 'CallMcpTool' }, heldSinceMs: 10 }, 20, 2500);
  assert.deepEqual(midTurn, { transition: { type: 'set', activity: THINKING_ACTIVITY }, state: initialHold });

  const ended = resolveHold({ type: 'turn-ended' }, initialHold, 30, 2500);
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

test('recovery constructors and wrappers fail fast when required anchors are missing', async () => {
  assert.throws(() => wrapActionHandler(class { runStep() {} }), /runModelOnlyStep/);
  assert.throws(() => wrapActionHandler(class { runStep() {} runModelOnlyStep() {} }), /runWithMaxTokensRetry/);
  assert.throws(() => wrapCreateTurnAgentComposition(null), /createTurnAgentComposition/);
  assert.throws(() => wrapResolveNamedActivityHold(null), /resolveNamedActivityHold/);

  assert.throws(
    () => constructRecoveredEngine({ getEngineRecoveryBindings: () => ({}) }, tmpdir()),
    /hasProjectSendMessageReminderForCurrentRequest/,
  );
  assert.throws(
    () => constructRecoveredEngine({
      getEngineRecoveryBindings: () => ({
        hasProjectSendMessageReminderForCurrentRequest: () => false,
        createProjectSendMessageVisibilityReminder: () => ({}),
        fromRedactedCoreMessages: msgs => msgs,
        PrivacyCapability: { UNSAFE_ALWAYS_ALLOWED: 'unsafe' },
      }),
    }, tmpdir()),
    /NonRetriableError/,
  );
  assert.throws(
    () => constructRecoveredHarness({ getHarnessRecoveryBindings: () => ({}) }, tmpdir()),
    /AnysphereAgent/,
  );
  await assert.rejects(
    () => installRecoveredHostExecutionAndSession({
      hostExecutionRecoveryPlan: { modules: [] },
      hostSessionRecoveryPlan: { modules: [] },
      getHostExecutionRecoveryBindings: () => ({ SandAgentRunner: class {} }),
      getHostSessionRecoveryBindings: () => ({}),
    }, tmpdir()),
    /resolveNamedActivityHold/,
  );
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
          async runModelOnlyStep() { return {}; }
          async runWithMaxTokensRetry(_ctx, _exec, fn, budget) { return fn({}, { outputTokenLimitRetryCount: 0, emptyResponseRetryTurnBudget: budget }); }
        }
        return { AbstractUserMessageActionHandler };
      }
    `);
    await writeFile(join(dir, 'harness.mjs'), `
      export function createRecoveredModule({ AnysphereAgent }) {
        return {
          createTurnAgentComposition(host) {
            return {
              buildAgentForRun(_s, _b, turnScope) {
                return new AnysphereAgent({ featureFlags: { userMessageTimestamps: true } }, { host, turnScope });
              },
            };
          },
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
      NonRetriableError: class extends Error {},
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
        fromRedactedCoreMessages: msgs => msgs,
        PrivacyCapability: { UNSAFE_ALWAYS_ALLOWED: 'unsafe' },
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
        modules: [{ name: 'harness.mjs', dependencies: ['AnysphereAgent'], recoveredDependencies: [], originalDependencies: ['AnysphereAgent'], exports: ['createTurnAgentComposition'] }],
      },
      getHarnessRecoveryBindings: () => ({ AnysphereAgent: BaseAgent }),
    }, dir);
    const userBuilt = harness.bindings.createTurnAgentComposition({ isSubagentRunner: false }).buildAgentForRun({}, {}, {});
    assert.ok(userBuilt instanceof BaseAgent);
    assert.equal(userBuilt.config.featureFlags.enableEmptyResponseRetry, true);
    const quietBuilt = harness.bindings.createTurnAgentComposition({ isSubagentRunner: false }).buildAgentForRun({}, {}, { isSilenceAllowed: true });
    assert.equal(quietBuilt.config.featureFlags.enableEmptyResponseRetry, false);

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
            const latest = result.endedOnSilentToolCalls ? await runner.run('first without a follow-up SendToUser', { hidden: true }) : result;
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
        setTurnTraceAttributes: () => {},
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

const hostSeedDir = process.env.PROKBOT_TEST_HOST_SEED ?? '';

test('pinned d0a4baa Host core installs turn-continuity wrappers cleanly and handles update_state / retry caps', { skip: !hostSeedDir && 'set PROKBOT_TEST_HOST_SEED to run the generated Host integration check' }, async () => {
  const relDir = join(hostSeedDir, 'release-reliability');
  const require = createRequire(import.meta.url);
  const library = require(join(relDir, 'host-library-reliable.cjs'));
  const core = await loadRecoveredHostCore(library, relDir);
  assert.equal(core.mode, 'recovered');

  // Verify real createTurnSettle ignores update_state after SendToUser.
  const { createTurnSettle } = library.getHarnessRecoveryBindings();
  const settle = createTurnSettle({
    isSubagentRunner: false,
    isRunSuperseded: () => false,
    latestPromptMessages: () => [
      { role: 'user', content: 'Remember that I like coffee.' },
      { role: 'assistant', content: [toolCall('SendToUser', 's-1'), toolCall('update_state', 'u-1')] },
      toolResult('SendToUser', 's-1'),
      toolResult('update_state', 'u-1'),
    ],
  }, {});
  await settle.settleCompletedTurn({
    finalState: { turnTimings: [] },
    turnStartedAtMs: Date.now(),
    hidden: false,
    trimmedPrompt: 'Remember that I like coffee.',
    skipLabeling: true,
  });
  assert.equal(settle.buildResult({ aborted: false }).endedOnSilentToolCalls, undefined);

  // Verify real TurnRuntime.ensureUserReply caps closing nudges at MAX_CLOSING_SEND_NUDGES (2).
  const { TurnRuntime } = library.getHostExecutionRecoveryBindings();
  let nudgeCount = 0;
  const tr = new TurnRuntime({
    sendPipeline: { currentTurnEpoch: () => 42 },
    telemetry: { reportClosingSendNudge: () => {} },
  });
  const settled = await tr.ensureUserReply(
    {
      run: async prompt => {
        nudgeCount += 1;
        assert.equal(prompt, CLOSING_SEND_NUDGE_PROMPT);
        return { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true };
      },
    },
    { sentMessageCount: 1, reacted: false, aborted: false, endedOnSilentToolCalls: true },
    { id: 'bot-real' },
    42,
  );
  assert.equal(nudgeCount, MAX_CLOSING_SEND_NUDGES);
  assert.equal(settled.result.endedOnSilentToolCalls, true);

  // Verify real AbstractUserMessageActionHandler.runWithMaxTokensRetry stops after MAX_OUTPUT_TOKEN_RETRIES_PER_STEP
  // with an error the Runner treats as terminal.
  const { AbstractUserMessageActionHandler } = library.getEngineRecoveryBindings();
  const mapError = createHarnessModelErrorMapper(library);
  const protoHandler = Object.create(AbstractUserMessageActionHandler.prototype);
  protoHandler.config = {};
  const appended = [];
  let tokenLimitAttempts = 0;
  await assert.rejects(
    () => protoHandler.runWithMaxTokensRetry(
      library.createContext(),
      { appendMessages: msgs => appended.push(...msgs) },
      async () => {
        tokenLimitAttempts += 1;
        throw mapError(new ModelRequestError('Model response stopped with max_tokens', { code: 'length' }));
      },
      { retriesUsed: 0 },
    ),
    error => error instanceof library.NonRetriableError && /max_tokens/.test(error.message),
  );
  assert.equal(tokenLimitAttempts, MAX_OUTPUT_TOKEN_RETRIES_PER_STEP + 1);
  assert.equal(appended.length, 1);
});
