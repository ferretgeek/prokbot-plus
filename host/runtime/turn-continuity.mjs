// Sustained multi-step turn continuity and working-indicator helpers for the local Host.
// Prevents premature silent stops after progress updates, tool results, or max-output truncation,
// and keeps live session activity visible until a turn actually settles.

export const DELIVERY_TOOL_NAMES = new Set([
  'SendToUser',
  'SendMessage',
  'ReactToMessage',
]);

// Bookkeeping / state-persistence tools whose invocation after a user-visible reply
// does not leave unreported work waiting for the user.
export const NON_SUBSTANTIVE_SILENT_TOOL_NAMES = new Set([
  'update_state',
  'TodoWrite',
  'todo_write',
  'SetStatus',
]);

export const THINKING_ACTIVITY = Object.freeze({ kind: 'thinking' });

export const MAX_CLOSING_SEND_NUDGES = 2;
export const MAX_EMPTY_RESPONSE_RETRIES_PER_TURN = 2;
export const MAX_VISIBILITY_REMINDERS_PER_TURN = 2;
export const MAX_OUTPUT_TOKEN_RETRIES_PER_STEP = 2;

export const CLOSING_SEND_NUDGE_PROMPT =
  'After your last SendToUser message, you ran additional tool calls without a follow-up SendToUser, ' +
  'so the results of that subsequent tool work have not been delivered to the user. ' +
  'Do NOT repeat results you already sent earlier. If that subsequent work produced new results, answers, or status ' +
  'the user needs, deliver only that new update now by invoking the SendToUser tool (plain assistant text is NEVER ' +
  'shown to the user; only a real SendToUser tool call reaches them). If the task is genuinely still unfinished, ' +
  'continue it and send the result with SendToUser once complete.';

export const SEND_TO_USER_VISIBILITY_REMINDER_TEXT =
  '<system_reminder>Your response was not visible to the user. Plain assistant text is never shown — ' +
  'invoke the SendToUser tool to send a user-visible update or final response, or continue making tool calls ' +
  'if your work is not yet finished.</system_reminder>';

const INJECTED_REMINDER_TEXT_MARKERS = [
  'You have made several tool calls without a SendToUser',
  'Remember: the user cannot see tool output or your thinking',
  'You opened this turn by calling tools without first acknowledging the user',
  'The box is near disk capacity.',
  'Please continue. Respond to the user or make tool calls.',
  'Your response was cut off because it exceeded the output token limit.',
  'Your response was not visible to the user.',
];

export function asCoreMessage(value) {
  if (typeof value !== 'object' || value === null) return undefined;
  if (typeof value.role !== 'string') return undefined;
  if (typeof value.content !== 'string' && !Array.isArray(value.content)) return undefined;
  return value;
}

function userMessageText(message) {
  if (message?.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

export function isInjectedReminderMessage(message) {
  if (!message) return false;
  const cursor = message.providerOptions?.cursor;
  if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
    if (
      cursor.sandSendMessageReminder === true ||
      cursor.sandEarlyResultReminder === true ||
      cursor.sandStartOfTurnAckReminder === true ||
      cursor.sandDiskPressureReminder === true ||
      cursor.loopReminder === true ||
      cursor.projectSendMessageReminder === true
    ) {
      return true;
    }
  }
  const text = userMessageText(message);
  if (typeof text !== 'string' || !text.trim().startsWith('<system_reminder>')) return false;
  return INJECTED_REMINDER_TEXT_MARKERS.some(marker => text.includes(marker));
}

export function isClosingSendNudgePrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  return (
    trimmed === CLOSING_SEND_NUDGE_PROMPT ||
    trimmed.includes('without a follow-up SendToUser')
  );
}

export function isReplyNudgePrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  return prompt.includes('you never called SendToUser that turn, or every SendToUser you tried failed to deliver');
}

function isToolMessageError(message, part) {
  if (part?.isError === true) return true;
  const highLevel = message?.providerOptions?.cursor?.highLevelToolCallResult;
  return Boolean(
    highLevel &&
    typeof highLevel === 'object' &&
    !Array.isArray(highLevel) &&
    highLevel.isError === true,
  );
}

function collectErroredToolResultIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (!message || message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string' && isToolMessageError(message, part)) {
        ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

function isSubstantiveNonDeliveryTool(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !DELIVERY_TOOL_NAMES.has(name) &&
    !NON_SUBSTANTIVE_SILENT_TOOL_NAMES.has(name);
}

/**
 * Determine whether the current turn performed substantive tool work after its last
 * successful user-visible delivery (SendToUser / SendMessage / ReactToMessage) without
 * a subsequent delivery. Bookkeeping tools (e.g. update_state, TodoWrite) do not
 * constitute unreported work.
 *
 * Unlike the pinned upstream helper, this handles:
 * - turns with multiple progress SendToUser messages before silent tool work,
 * - turns that ran tools before their first SendToUser,
 * - parallel [SendToUser, <work-tool>] assistant steps,
 * - turns whose final assistant message is blank, reasoning-only, or invisible plain text.
 *
 * When `requirePriorDelivery` is true (normal user turns), returns false if the turn had
 * zero successful deliveries so the dedicated reply-nudge loop handles it instead.
 * When `requirePriorDelivery` is false (hidden closing-send nudge turns), also returns
 * true if the nudge executed substantive tool calls and still delivered nothing.
 */
export function detectSilentToolCallEnding(rawMessages, { requirePriorDelivery = true } = {}) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return false;
  const messages = rawMessages.map(asCoreMessage);

  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || isInjectedReminderMessage(message)) continue;
    if (message.role === 'user' || message.role === 'system') {
      boundary = index;
      break;
    }
  }

  const turnMessages = messages.slice(boundary + 1);
  const erroredIds = collectErroredToolResultIds(turnMessages);
  let hasSuccessfulDelivery = false;
  let hasSilentWorkAfterLastDelivery = false;

  for (const message of turnMessages) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const toolCalls = message.content.filter(part => part?.type === 'tool-call' && typeof part.toolName === 'string');
    if (toolCalls.length === 0) continue;

    const deliveredHere = toolCalls.some(
      part => DELIVERY_TOOL_NAMES.has(part.toolName) && !erroredIds.has(part.toolCallId),
    );
    const hasSubstantiveWork = toolCalls.some(part => isSubstantiveNonDeliveryTool(part.toolName));

    if (deliveredHere) {
      hasSuccessfulDelivery = true;
      // Parallel [SendToUser("working on it..."), CallMcpTool(...)] leaves the tool result unreported,
      // whereas parallel [SendToUser("noted"), update_state(...)] does not.
      hasSilentWorkAfterLastDelivery = hasSubstantiveWork;
    } else if (hasSubstantiveWork) {
      hasSilentWorkAfterLastDelivery = true;
    }
  }

  if (!hasSilentWorkAfterLastDelivery) return false;
  return requirePriorDelivery ? hasSuccessfulDelivery : true;
}

/**
 * True when the latest tool-result batch waiting on the model includes substantive
 * non-delivery tool output (or a failed delivery tool), ignoring any trailing injected
 * reminder messages. Used so an earlier progress SendToUser does not disable
 * in-loop empty/thinking-only or missing-SendToUser retries after subsequent tool work.
 */
export function hasTrailingNonDeliveryToolResult(rawMessages) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return false;
  let index = rawMessages.length - 1;
  while (index >= 0) {
    const message = asCoreMessage(rawMessages[index]);
    if (!message || isInjectedReminderMessage(message)) {
      index--;
      continue;
    }
    break;
  }

  while (index >= 0) {
    const message = asCoreMessage(rawMessages[index]);
    if (!message) {
      index--;
      continue;
    }
    if (message.role !== 'tool') break;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== 'tool-result') continue;
        if (isSubstantiveNonDeliveryTool(part.toolName)) return true;
        if (DELIVERY_TOOL_NAMES.has(part.toolName) && isToolMessageError(message, part)) return true;
      }
    }
    index--;
  }
  return false;
}

/**
 * Check whether a project SendMessage/SendToUser visibility reminder should suppress
 * another missing-SendToUser retry on this step.
 *
 * Performs a single backwards scan to the turn boundary: returns true if a reminder was
 * already injected since the latest substantive non-delivery tool result OR if the turn
 * has already reached `maxPerTurn` visibility reminders.
 */
export function hasVisibilityReminderSinceLastWork(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const maxPerTurn =
    typeof options === 'object' && options !== null && Number.isInteger(options.maxPerTurn) && options.maxPerTurn > 0
      ? options.maxPerTurn
      : MAX_VISIBILITY_REMINDERS_PER_TURN;

  let remindersInTurn = 0;
  let sawWorkBeforeReminder = false;
  let remindedSinceLastWork;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asCoreMessage(messages[index]);
    if (!message) continue;
    const cursor = message.providerOptions?.cursor;
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      if (cursor.projectSendMessageReminder === true) {
        remindersInTurn += 1;
        if (!sawWorkBeforeReminder && remindedSinceLastWork === undefined) {
          remindedSinceLastWork = true;
        }
        if (remindersInTurn >= maxPerTurn) return true;
        continue;
      }
      if (cursor.projectSendMessageRequestBoundary === true) {
        break;
      }
    }
    if (!isInjectedReminderMessage(message) && (message.role === 'user' || message.role === 'system')) {
      break;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const hasWorkResult = message.content.some(
        part => part?.type === 'tool-result' && isSubstantiveNonDeliveryTool(part.toolName),
      );
      if (hasWorkResult) {
        sawWorkBeforeReminder = true;
        if (remindedSinceLastWork === undefined) remindedSinceLastWork = false;
      }
    }
  }
  return remindedSinceLastWork === true;
}

export function createSendToUserVisibilityReminder(originalFactory) {
  const base = typeof originalFactory === 'function' ? originalFactory() : undefined;
  const cursorOptions = base?.providerOptions?.cursor;
  return {
    role: 'user',
    content: SEND_TO_USER_VISIBILITY_REMINDER_TEXT,
    providerOptions: {
      cursor: {
        ...(cursorOptions && typeof cursorOptions === 'object' && !Array.isArray(cursorOptions) ? cursorOptions : {}),
        projectSendMessageReminder: true,
      },
    },
  };
}

/**
 * Wrap RunLifecycle.resolveNamedActivityHold so a mid-turn SendToUser keeps the
 * session visibly in the `thinking` state while the turn continues, instead of
 * clearing `currentActivity` back to undefined until the next streamed chunk.
 * `turn-ended` and `endSessionRun` still clear activity.
 */
export function wrapResolveNamedActivityHold(originalResolve, initialHoldState) {
  if (typeof originalResolve !== 'function') {
    throw new TypeError('Missing Host execution dependency: resolveNamedActivityHold');
  }
  return (update, state, nowMs, maxHoldMs) => {
    if (update?.type === 'send-message') {
      return {
        transition: { type: 'set', activity: THINKING_ACTIVITY },
        state: initialHoldState,
      };
    }
    return originalResolve(update, state, nowMs, maxHoldMs);
  };
}

const RUN_LIFECYCLE_WRAPPED = Symbol('prokbot.runLifecycleWrapped');
const TURN_RUNTIME_WRAPPED = Symbol('prokbot.turnRuntimeWrapped');
const ACTION_HANDLER_WRAPPED = Symbol('prokbot.actionHandlerWrapped');

const pendingRetryPolicyStack = [];

export function shouldEnableEmptyResponseRetry(host, turnScope) {
  return (
    !host?.isSubagentRunner &&
    turnScope?.isSilenceAllowed !== true &&
    turnScope?.isGroupMemberTurn !== true
  );
}

/**
 * Wrap createTurnSettle so hidden continuation nudges (closing-send nudge and
 * reply nudge) also detect trailing silent tool work without affecting background
 * or automation hidden turns.
 */
export function wrapCreateTurnSettle(originalCreateTurnSettle) {
  if (typeof originalCreateTurnSettle !== 'function') {
    throw new TypeError('Missing Host flow dependency: createTurnSettle');
  }
  return function createTurnSettleWithContinuity(host, scope) {
    const inner = originalCreateTurnSettle(host, scope);
    let hiddenNudgeEndedOnSilentTools = false;
    return {
      ...inner,
      async settleCompletedTurn(args) {
        await inner.settleCompletedTurn(args);
        if (!host?.isSubagentRunner && args?.hidden === true) {
          if (isClosingSendNudgePrompt(args.trimmedPrompt)) {
            hiddenNudgeEndedOnSilentTools = detectSilentToolCallEnding(
              host.latestPromptMessages(),
              { requirePriorDelivery: false },
            );
          } else if (isReplyNudgePrompt(args.trimmedPrompt)) {
            hiddenNudgeEndedOnSilentTools = detectSilentToolCallEnding(
              host.latestPromptMessages(),
              { requirePriorDelivery: true },
            );
          }
        }
      },
      buildResult(flags) {
        const result = inner.buildResult(flags);
        if (hiddenNudgeEndedOnSilentTools && result?.endedOnSilentToolCalls !== true) {
          return { ...result, endedOnSilentToolCalls: true };
        }
        return result;
      },
    };
  };
}

/**
 * Wrap AnysphereAgent so `buildAgentForRun` can scope `enableEmptyResponseRetry`
 * strictly to normal user turns (never subagents, `isSilenceAllowed`, or group members).
 */
export function wrapAnysphereAgent(AnysphereAgent) {
  if (typeof AnysphereAgent !== 'function') {
    throw new TypeError('Missing Harness dependency: AnysphereAgent');
  }
  return class LocalContinuousAnysphereAgent extends AnysphereAgent {
    constructor(config, ...rest) {
      const scopedPolicy = pendingRetryPolicyStack.at(-1);
      const featureFlags = config && typeof config === 'object' ? config.featureFlags : undefined;
      const nextConfig =
        scopedPolicy !== undefined &&
        config &&
        typeof config === 'object' &&
        featureFlags?.enableEmptyResponseRetry === undefined
          ? { ...config, featureFlags: { ...(featureFlags ?? {}), enableEmptyResponseRetry: scopedPolicy } }
          : config;
      super(nextConfig, ...rest);
    }
  };
}

/**
 * Wrap createTurnAgentComposition so `enableEmptyResponseRetry` is enabled only for
 * normal user turns and kept disabled for subagents, `isSilenceAllowed` runs (automations,
 * background wakes, broadcasts), and group-member turns.
 */
export function wrapCreateTurnAgentComposition(originalCreateTurnAgentComposition) {
  if (typeof originalCreateTurnAgentComposition !== 'function') {
    throw new TypeError('Missing Harness dependency: createTurnAgentComposition');
  }
  return function createTurnAgentCompositionWithRetryPolicy(host, ...rest) {
    const composition = originalCreateTurnAgentComposition(host, ...rest);
    if (!composition || typeof composition.buildAgentForRun !== 'function') {
      throw new TypeError('Missing Harness composition helper: buildAgentForRun');
    }
    return {
      ...composition,
      buildAgentForRun(sessions, boxConnection, turnScope, ...extra) {
        const enableEmptyResponseRetry = shouldEnableEmptyResponseRetry(host, turnScope);
        pendingRetryPolicyStack.push(enableEmptyResponseRetry);
        let agent;
        try {
          agent = composition.buildAgentForRun(sessions, boxConnection, turnScope, ...extra);
        } finally {
          pendingRetryPolicyStack.pop();
        }
        if (agent?.config && typeof agent.config === 'object') {
          const featureFlags = agent.config.featureFlags;
          if (featureFlags?.enableEmptyResponseRetry === undefined) {
            agent.config.featureFlags = {
              ...(featureFlags ?? {}),
              enableEmptyResponseRetry,
            };
          }
        }
        return agent;
      },
    };
  };
}

function isOutputTokensLimitExceededError(error) {
  return Boolean(error && error.name === 'OutputTokensLimitExceededError');
}

function createExhaustedOutputTokensError(sourceError, maxRetries) {
  const detail =
    typeof sourceError?.message === 'string' && sourceError.message.trim().length > 0
      ? sourceError.message.trim()
      : 'Model output exceeded the output token limit';
  const cause = sourceError?.cause ?? sourceError;
  return new Error(
    `Output exceeded max output tokens after ${maxRetries} continuation ${maxRetries === 1 ? 'retry' : 'retries'}: ${detail}`,
    cause ? { cause } : undefined,
  );
}

/**
 * Wrap AbstractUserMessageActionHandler so:
 * - an earlier progress SendToUser does not suppress in-loop retries after subsequent
 *   substantive tool results (only inspecting trailing messages when hasSendMessageCall is true),
 * - empty-response / missing-SendToUser retries stay bounded per turn (`maxEmptyResponseRetriesPerTurn`),
 * - `OutputTokensLimitExceededError` (`length`) retries are bounded per step (`maxOutputTokenRetriesPerStep`)
 *   and surface the original truncation error rather than a generic `step-retries` failure.
 */
export function wrapActionHandler(
  ActionHandler,
  {
    fromRedactedCoreMessages,
    PrivacyCapability,
    maxEmptyResponseRetriesPerTurn = MAX_EMPTY_RESPONSE_RETRIES_PER_TURN,
    maxOutputTokenRetriesPerStep = MAX_OUTPUT_TOKEN_RETRIES_PER_STEP,
  } = {},
) {
  if (typeof ActionHandler !== 'function' || typeof ActionHandler.prototype?.runStep !== 'function') {
    throw new TypeError('Missing Engine dependency: AbstractUserMessageActionHandler.runStep');
  }
  if (typeof ActionHandler.prototype?.runModelOnlyStep !== 'function') {
    throw new TypeError('Missing Engine dependency: AbstractUserMessageActionHandler.runModelOnlyStep');
  }
  if (typeof ActionHandler.prototype?.runWithMaxTokensRetry !== 'function') {
    throw new TypeError('Missing Engine dependency: AbstractUserMessageActionHandler.runWithMaxTokensRetry');
  }
  if (ActionHandler[ACTION_HANDLER_WRAPPED]) return ActionHandler;

  const readTrailingExecutorMessages = rootPromptExecutor => {
    if (typeof rootPromptExecutor?.innerToolExecutor?.getMessages === 'function') {
      const plain = rootPromptExecutor.innerToolExecutor.getMessages();
      return Array.isArray(plain) ? plain : [];
    }
    const raw = typeof rootPromptExecutor?.getMessages === 'function' ? rootPromptExecutor.getMessages() : undefined;
    if (!Array.isArray(raw) || raw.length === 0) return [];

    // Find only the trailing tool/reminder slice so we avoid unwrapping the full history on every step.
    let tailStart = raw.length;
    for (let index = raw.length - 1; index >= 0; index--) {
      const role = raw[index]?.role;
      if (role === 'assistant' || role === 'system') break;
      tailStart = index;
    }
    const tail = raw.slice(tailStart);
    if (tail.length === 0) return [];
    if (typeof fromRedactedCoreMessages === 'function' && PrivacyCapability?.UNSAFE_ALWAYS_ALLOWED !== undefined) {
      try {
        return fromRedactedCoreMessages(tail, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      } catch {
        return tail;
      }
    }
    return tail;
  };

  const wrapStepMethod = methodName => {
    const originalMethod = ActionHandler.prototype[methodName];
    ActionHandler.prototype[methodName] = async function wrappedStepMethod(
      parentCtx,
      turn,
      rootPromptExecutor,
      ...rest
    ) {
      const maskDeliveryForStep =
        turn != null &&
        typeof turn.hasSendMessageCall === 'function' &&
        turn.hasSendMessageCall() === true &&
        hasTrailingNonDeliveryToolResult(readTrailingExecutorMessages(rootPromptExecutor));
      if (!maskDeliveryForStep) {
        return originalMethod.call(this, parentCtx, turn, rootPromptExecutor, ...rest);
      }
      const hadOwn = Object.prototype.hasOwnProperty.call(turn, 'hasSendMessageCall');
      const previousDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(turn, 'hasSendMessageCall') : undefined;
      Object.defineProperty(turn, 'hasSendMessageCall', {
        value: () => false,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      try {
        return await originalMethod.call(this, parentCtx, turn, rootPromptExecutor, ...rest);
      } finally {
        if (hadOwn && previousDescriptor) {
          Object.defineProperty(turn, 'hasSendMessageCall', previousDescriptor);
        } else {
          delete turn.hasSendMessageCall;
        }
      }
    };
  };

  const originalRunWithMaxTokensRetry = ActionHandler.prototype.runWithMaxTokensRetry;
  ActionHandler.prototype.runWithMaxTokensRetry = async function wrappedRunWithMaxTokensRetry(
    parentCtx,
    rootPromptExecutor,
    fn,
    emptyResponseRetryTurnBudget,
  ) {
    let lastOutputTokenError;
    try {
      return await originalRunWithMaxTokensRetry.call(
        this,
        parentCtx,
        rootPromptExecutor,
        async (retryCtx, debug) => {
          const budgetUsed =
            debug?.emptyResponseRetryTurnBudget?.retriesUsed ??
            emptyResponseRetryTurnBudget?.retriesUsed ??
            0;
          const effectiveDebug =
            debug && typeof debug === 'object' && budgetUsed >= maxEmptyResponseRetriesPerTurn
              ? { ...debug, didRetryAfterEmptyResponse: true }
              : debug;
          try {
            return await fn(retryCtx, effectiveDebug);
          } catch (error) {
            if (isOutputTokensLimitExceededError(error)) {
              lastOutputTokenError = error;
              const usedRetries = debug?.outputTokenLimitRetryCount ?? 0;
              if (usedRetries >= maxOutputTokenRetriesPerStep) {
                throw createExhaustedOutputTokensError(error, maxOutputTokenRetriesPerStep);
              }
            }
            throw error;
          }
        },
        emptyResponseRetryTurnBudget,
      );
    } catch (error) {
      if (lastOutputTokenError && error?.name === 'StepRetriesExhaustedError') {
        throw createExhaustedOutputTokensError(lastOutputTokenError, maxOutputTokenRetriesPerStep);
      }
      throw error;
    }
  };

  wrapStepMethod('runStep');
  wrapStepMethod('runModelOnlyStep');
  ActionHandler[ACTION_HANDLER_WRAPPED] = true;
  return ActionHandler;
}

/**
 * Wrap RunLifecycle so newly started runs immediately carry `{ kind: 'thinking' }`
 * on their first roster delta instead of leaving `currentActivity` undefined until
 * the first streamed reasoning/tool chunk.
 */
export function wrapRunLifecycle(RunLifecycle) {
  if (typeof RunLifecycle !== 'function' || typeof RunLifecycle.prototype?.beginSessionRun !== 'function') {
    throw new TypeError('Missing Host execution dependency: RunLifecycle.beginSessionRun');
  }
  if (RunLifecycle[RUN_LIFECYCLE_WRAPPED]) return RunLifecycle;
  const originalBegin = RunLifecycle.prototype.beginSessionRun;
  RunLifecycle.prototype.beginSessionRun = function beginSessionRunWithInitialActivity(session, options) {
    const inFlight = this.inFlightRunCounts?.get(session) ?? 0;
    if (inFlight === 0 && session?.id && this.sessionActivities && !this.sessionActivities.has(session.id)) {
      this.sessionActivities.set(session.id, THINKING_ACTIVITY);
    }
    return originalBegin.call(this, session, options);
  };
  RunLifecycle[RUN_LIFECYCLE_WRAPPED] = true;
  return RunLifecycle;
}

/**
 * Wrap TurnRuntime so closing-send nudges can continue across multiple tool-heavy
 * recovery steps (bounded by MAX_CLOSING_SEND_NUDGES) with non-repeating nudge wording
 * and `sand.closing_send_nudge` trace attribution on every closing nudge.
 */
export function wrapTurnRuntime(
  TurnRuntime,
  {
    maxClosingSendNudges = MAX_CLOSING_SEND_NUDGES,
    closingPrompt = CLOSING_SEND_NUDGE_PROMPT,
    setTurnTraceAttributes,
  } = {},
) {
  if (typeof TurnRuntime !== 'function' || typeof TurnRuntime.prototype?.ensureUserReply !== 'function') {
    throw new TypeError('Missing Host execution dependency: TurnRuntime.ensureUserReply');
  }
  if (TurnRuntime[TURN_RUNTIME_WRAPPED]) return TurnRuntime;
  const originalEnsureUserReply = TurnRuntime.prototype.ensureUserReply;
  TurnRuntime.prototype.ensureUserReply = async function ensureUserReplyWithBoundedClosingNudges(
    runner,
    result,
    session,
    epoch,
    ackToken,
    traceCtx,
    turnTrace,
    turn,
    onPersistableRunStarted,
  ) {
    const nudgeRunner =
      closingPrompt && runner && typeof runner.run === 'function'
        ? new Proxy(runner, {
            get(target, prop) {
              if (prop === 'run') {
                return (prompt, runOptions) => {
                  const effectivePrompt = isClosingSendNudgePrompt(prompt) ? closingPrompt : prompt;
                  return target.run(effectivePrompt, runOptions);
                };
              }
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        : runner;

    const settled = await originalEnsureUserReply.call(
      this,
      nudgeRunner,
      result,
      session,
      epoch,
      ackToken,
      traceCtx,
      turnTrace,
      turn,
      onPersistableRunStarted,
    );

    let latest = settled.result;
    let deliveryOwed = settled.deliveryOwed;
    let streamOutputProduced = settled.streamOutputProduced;
    // The original ensureUserReply already performed 1 closing nudge if latest.endedOnSilentToolCalls was set
    // on the initial result (or after reply nudges). Allow up to maxClosingSendNudges total.
    let closingNudges = 1;

    while (
      closingNudges < maxClosingSendNudges &&
      latest?.endedOnSilentToolCalls === true &&
      !latest.aborted &&
      latest.pausedForUpgrade !== true &&
      latest.awaitingUserSelection !== true &&
      epoch === this.tm.sendPipeline.currentTurnEpoch(session)
    ) {
      closingNudges += 1;
      setTurnTraceAttributes?.(turnTrace, { 'sand.closing_send_nudge': true });
      let nudged;
      try {
        nudged = await runner.run(closingPrompt, {
          hidden: true,
          advanceChainOnDelivery: false,
          ackToken,
          traceCtx,
          onModelResolved: modelId => turn?.setModel(modelId),
          onPersistableRunStarted,
        });
        latest = nudged;
        deliveryOwed = deliveryOwed && nudged.sentMessageCount === 0 && !nudged.reacted;
        streamOutputProduced = streamOutputProduced || nudged.streamOutputProduced === true;
      } finally {
        this.tm.telemetry?.reportClosingSendNudge?.({
          conversationId: session.id,
          delivered: nudged != null && (nudged.sentMessageCount > 0 || nudged.reacted),
          sentMessageCount: nudged?.sentMessageCount ?? 0,
          aborted: nudged?.aborted ?? false,
        });
      }
    }

    return {
      ...settled,
      result: latest,
      deliveryOwed,
      streamOutputProduced,
    };
  };
  TurnRuntime[TURN_RUNTIME_WRAPPED] = true;
  return TurnRuntime;
}
