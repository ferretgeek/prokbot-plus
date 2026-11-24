// Sustained multi-step turn continuity and working-indicator helpers for the local Host.
// Prevents premature silent stops after progress updates, tool results, or max-output truncation,
// and keeps live session activity visible until a turn actually settles.

export const DELIVERY_TOOL_NAMES = new Set([
  'SendToUser',
  'SendMessage',
  'ReactToMessage',
]);

export const NON_SUBSTANTIVE_SILENT_TOOL_NAMES = new Set([
  'SetStatus',
]);

export const THINKING_ACTIVITY = Object.freeze({ kind: 'thinking' });

export const MAX_CLOSING_SEND_NUDGES = 3;

export const CLOSING_SEND_NUDGE_PROMPT =
  'Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendToUser — ' +
  'the last thing the user saw is that opening acknowledgement, so whatever the tool calls produced after it never reached them. ' +
  'If that work produced the result or answer they are waiting on, deliver it now by actually invoking the SendToUser tool — ' +
  'make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser ' +
  'tool invocation reaches them. If the work is genuinely unfinished, continue it and send the result once you have it.';

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
    trimmed.includes('ended without a follow-up SendToUser')
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
 * a subsequent delivery.
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
      // Parallel [SendToUser("working on it..."), CallMcpTool(...)] leaves the tool result unreported.
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
 * Check whether a project SendMessage/SendToUser visibility reminder was already
 * injected since the latest request boundary OR the latest substantive non-delivery
 * tool result. Resetting across new tool results prevents an earlier reminder from
 * permanently disabling retry protection for later steps in the same turn.
 */
export function hasVisibilityReminderSinceLastWork(messages, originalCheck) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  let index = messages.length - 1;
  for (; index >= 0; index--) {
    const message = asCoreMessage(messages[index]);
    if (!message) continue;
    const cursor = message.providerOptions?.cursor;
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      if (cursor.projectSendMessageReminder === true) return true;
      if (cursor.projectSendMessageRequestBoundary === true) return false;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const hasWorkResult = message.content.some(
        part => part?.type === 'tool-result' && isSubstantiveNonDeliveryTool(part.toolName),
      );
      if (hasWorkResult) return false;
    }
  }
  return typeof originalCheck === 'function' ? originalCheck(messages) : false;
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
 * clearing `currentActivity` back to undefined (which triggers the Desktop 1.2.3
 * 5-second quiet delay). `turn-ended` and `endSessionRun` still clear activity.
 */
export function wrapResolveNamedActivityHold(originalResolve, initialHoldState) {
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
 * Wrap AnysphereAgent so local Host runs default `enableEmptyResponseRetry` to true
 * unless explicitly disabled by a caller.
 */
export function wrapAnysphereAgent(AnysphereAgent) {
  if (typeof AnysphereAgent !== 'function') {
    throw new TypeError('Missing Harness dependency: AnysphereAgent');
  }
  return class LocalContinuousAnysphereAgent extends AnysphereAgent {
    constructor(config, ...rest) {
      const featureFlags = config && typeof config === 'object' ? config.featureFlags : undefined;
      const nextConfig =
        config && typeof config === 'object' && featureFlags?.enableEmptyResponseRetry === undefined
          ? { ...config, featureFlags: { ...(featureFlags ?? {}), enableEmptyResponseRetry: true } }
          : config;
      super(nextConfig, ...rest);
    }
  };
}

/**
 * Wrap AbstractUserMessageActionHandler so an earlier progress SendToUser does not
 * suppress in-loop empty/thinking-only or missing-SendToUser retries when the step
 * immediately follows substantive non-delivery tool results.
 */
export function wrapActionHandler(ActionHandler, { fromRedactedCoreMessages, PrivacyCapability } = {}) {
  if (typeof ActionHandler !== 'function' || typeof ActionHandler.prototype?.runStep !== 'function') {
    throw new TypeError('Missing Engine dependency: AbstractUserMessageActionHandler.runStep');
  }
  if (ActionHandler[ACTION_HANDLER_WRAPPED]) return ActionHandler;

  const unwrapMessages = raw => {
    if (!Array.isArray(raw)) return [];
    if (typeof fromRedactedCoreMessages === 'function' && PrivacyCapability?.UNSAFE_ALWAYS_ALLOWED !== undefined) {
      try {
        return fromRedactedCoreMessages(raw, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      } catch {
        return raw;
      }
    }
    return raw;
  };

  const wrapStepMethod = methodName => {
    const originalMethod = ActionHandler.prototype[methodName];
    if (typeof originalMethod !== 'function') return;
    ActionHandler.prototype[methodName] = async function wrappedStepMethod(
      parentCtx,
      turn,
      rootPromptExecutor,
      ...rest
    ) {
      const executorMessages = typeof rootPromptExecutor?.getMessages === 'function'
        ? unwrapMessages(rootPromptExecutor.getMessages())
        : [];
      const maskDeliveryForStep =
        turn != null &&
        typeof turn.hasSendMessageCall === 'function' &&
        hasTrailingNonDeliveryToolResult(executorMessages);
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
 * recovery steps (bounded by MAX_CLOSING_SEND_NUDGES) instead of stopping after a
 * single hidden nudge that ran further tools without calling SendToUser.
 */
export function wrapTurnRuntime(TurnRuntime, { maxClosingSendNudges = MAX_CLOSING_SEND_NUDGES, closingPrompt = CLOSING_SEND_NUDGE_PROMPT } = {}) {
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
    const settled = await originalEnsureUserReply.call(
      this,
      runner,
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
