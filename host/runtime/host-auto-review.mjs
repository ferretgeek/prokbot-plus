import { randomUUID } from 'node:crypto';
import { recordUsage } from './usage-ledger.mjs';
import { anthropicEndpoint, anthropicHeaders, anthropicOptions, anthropicUsage } from './anthropic-messages.mjs';
import { chatEndpoint, chatReasoning, maxTokensParameter } from './openai-chat.mjs';
import { reasons, responsesEndpoint, responsesUsage } from './openai-responses.mjs';
import { postWithFallback } from './model-common.mjs';

const OUTPUT_LIMIT = 16_000;
// Classification needs little reasoning; use the lowest level the model offers.
function reviewEffort(config) {
  const efforts = config.policy?.models?.find(entry => entry.id === config.model)?.efforts ?? [];
  return ['low', 'minimal', 'medium'].find(level => efforts.includes(level));
}
/** The model answered, but not with one valid classification; worth one more attempt. */
class ReviewOutputError extends Error {}
const forcedChoiceRejected = error => error.status === 400 && /tool_choice|tool choice/i.test(error.message);
const onlyTool = name => `\n\nRespond only by calling the ${name} tool exactly once.`;

function single(calls, name, truncated) {
  if (truncated || calls.length !== 1 || calls[0].name !== name) throw new ReviewOutputError('Auto-review model did not return one complete classification');
  if (typeof calls[0].arguments !== 'string') return calls[0].arguments;
  try { return JSON.parse(calls[0].arguments); }
  catch { throw new ReviewOutputError('Auto-review model returned invalid JSON'); }
}

async function classifyWithChat(config, library, tool, content, signal, fetchImpl, state) {
  let forced = !state.autoToolChoice;
  const { http } = await postWithFallback({ fetchImpl, url: chatEndpoint(config.baseUrl), apiKey: config.apiKey, signal, state,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    optional: ['reasoning_effort', 'thinking', 'parallel_tool_calls', 'max_tokens', 'max_completion_tokens'],
    fallbacks: [{ name: 'automatic tool choice', applies: error => forced && forcedChoiceRejected(error), apply: () => { forced = false; state.autoToolChoice = true; } }],
    build: () => {
      const limit = maxTokensParameter(config.model, state.dropped);
      return { model: config.model, stream: false, ...chatReasoning(config.model, reviewEffort(config)), ...(limit ? { [limit]: OUTPUT_LIMIT } : {}),
        messages: [{ role: 'system', content: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT + (forced ? '' : onlyTool(tool.function.name)) },
          { role: 'user', content }], tools: [tool], parallel_tool_calls: false,
        tool_choice: forced ? { type: 'function', function: { name: tool.function.name } } : 'auto' };
    } });
  const reply = await http.json();
  await recordUsage(config.usageDirectory, { raw: reply.usage, model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
  const calls = (reply.choices?.[0]?.message?.tool_calls ?? []).map(call => ({ name: call.function?.name, arguments: call.function?.arguments }));
  return { id: reply.id, decision: single(calls, tool.function.name, reply.choices?.[0]?.finish_reason === 'length') };
}

async function classifyWithResponses(config, library, tool, content, signal, fetchImpl, state) {
  let forced = !state.autoToolChoice;
  const efforts = config.policy?.models?.find(entry => entry.id === config.model)?.efforts, effort = reviewEffort(config);
  const { http } = await postWithFallback({ fetchImpl, url: responsesEndpoint(config.baseUrl), apiKey: config.apiKey, signal, state,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    optional: ['reasoning.effort', 'reasoning', 'parallel_tool_calls', 'store', 'max_output_tokens'],
    fallbacks: [{ name: 'automatic tool choice', applies: error => forced && forcedChoiceRejected(error), apply: () => { forced = false; state.autoToolChoice = true; } }],
    build: () => ({ model: config.model, store: false, max_output_tokens: OUTPUT_LIMIT,
      ...(reasons(efforts) && effort ? { reasoning: { effort } } : {}),
      instructions: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT + (forced ? '' : onlyTool(tool.function.name)),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] }],
      tools: [{ type: 'function', name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters, strict: false }],
      parallel_tool_calls: false, tool_choice: forced ? { type: 'function', name: tool.function.name } : 'auto' }) });
  const reply = await http.json();
  await recordUsage(config.usageDirectory, { raw: responsesUsage(reply.usage), model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
  const calls = (reply.output ?? []).filter(item => item.type === 'function_call');
  return { id: reply.id, decision: single(calls, tool.function.name, reply.status === 'incomplete') };
}

/** Messages API classification. Forced tool choice is unavailable on current Claude models. */
async function classifyWithAnthropic(config, library, tool, content, signal, fetchImpl, state) {
  const { http } = await postWithFallback({ fetchImpl, url: anthropicEndpoint(config.baseUrl), apiKey: config.apiKey, signal, state,
    headers: body => anthropicHeaders(config.apiKey, { body }), optional: ['fallbacks', 'thinking.display', 'output_config'],
    build: () => ({ model: config.model, ...anthropicOptions(config.model, { effort: reviewEffort(config) ?? 'low', maxTokens: OUTPUT_LIMIT }),
      system: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT + onlyTool(tool.function.name),
      messages: [{ role: 'user', content }], tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      tools: [{ name: tool.function.name, description: tool.function.description ?? '', input_schema: tool.function.parameters }] }) });
  const reply = await http.json();
  await recordUsage(config.usageDirectory, { raw: anthropicUsage(reply.usage), model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
  const calls = (reply.content ?? []).filter(block => block.type === 'tool_use').map(block => ({ name: block.name, arguments: block.input }));
  return { id: reply.id, decision: single(calls, tool.function.name, reply.stop_reason === 'max_tokens') };
}

const CLASSIFIERS = { openai: classifyWithChat, 'openai-responses': classifyWithResponses, anthropic: classifyWithAnthropic };

function validate(decision, schema) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new ReviewOutputError('Invalid auto-review classification');
  for (const name of schema.required) {
    if (typeof decision[name] !== 'string' || !decision[name].trim() ||
      (schema.properties[name].enum && !schema.properties[name].enum.includes(decision[name])))
      throw new ReviewOutputError(`Invalid auto-review classification field: ${name}`);
  }
  if (decision.decision === 'BLOCK' && decision.blocked_effect === 'none')
    throw new ReviewOutputError('Auto-review returned an inconsistent decision');
  const outbound = ['outbound_or_binding_external_effect', 'data_or_credential_exfiltration'].includes(decision.blocked_effect);
  if (decision.decision === 'BLOCK' && outbound &&
    (decision.outbound_authorization !== 'unauthorized_destination' || !decision.who_sees_it?.trim()))
    throw new ReviewOutputError('Auto-review returned an incomplete outbound decision');
  if (decision.proposed_allow_rule !== undefined && typeof decision.proposed_allow_rule !== 'string')
    throw new ReviewOutputError('Invalid auto-review proposed rule');
}

/** Use the shipped classifier policy/schema and approval state machine with the configured model. */
export function createLocalClassifier(config, library, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const tool = library.CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL;
  const schema = tool.function.parameters;
  // Parameters a compatible service rejected stay dropped for later reviews.
  const state = { dropped: new Set(), autoToolChoice: false };
  return {
    async execute(ctx, args) {
      const target = args.target?.toJson ? args.target.toJson() : args.target;
      if (!target || typeof target.action !== 'string') throw new Error('Auto-review target is missing');
      const messages = args.conversationContext ?? [];
      const input = {
        trusted_user_instructions: messages.filter(item => item.role === 'user').map(item => item.content),
        untrusted_agent_narration_and_prior_actions: messages.filter(item => item.role !== 'user')
          .map(item => ({ role: item.role, content: item.content })),
        proposed_tool_call: target,
        trusted_auto_run_policy_instructions: target.arguments?.project_permissions?.auto_run ?? {},
      };
      const content = JSON.stringify(input);
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Auto-review context exceeds the supported size');
      const signal = ctx?.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
      const classify = CLASSIFIERS[config.apiFormat] ?? classifyWithChat;
      let replyId, decision;
      // A malformed answer is retried once; service errors and cancellation are not.
      for (let attempt = 1; ; attempt++) {
        try {
          ({ id: replyId, decision } = await classify(config, library, tool, content, signal, fetchImpl, state));
          validate(decision, schema);
          break;
        } catch (error) {
          const retry = error instanceof ReviewOutputError && attempt < 2 && !signal.aborted;
          log(`Local auto-review ${retry ? 'retrying after' : 'failed'}: ${error.message}; model=${config.model}`);
          if (!retry) throw error;
        }
      }
      const proposedRule = decision.proposed_allow_rule;
      log(`Local auto-review ${decision.decision}; model=${config.model}; request=${String(replyId ?? 'unavailable').slice(0, 128)}`);
      return new library.SmartModeClassifierResult({ result: { case: 'success', value: {
        decision: decision.decision === 'ALLOW' ? 1 : 2,
        ...(decision.decision === 'BLOCK' ? { blockReason: decision.reason.slice(0, 500) } : {}),
        ...(decision.decision === 'BLOCK' && proposedRule ? { proposedAllowRule: proposedRule.slice(0, 500) } : {}),
      } } });
    },
  };
}

export function startLocalAutoReview(context, library, config) {
  const service = new library.AutoReviewService({
    auth: context.deps.auth,
    experiments: { checkFeatureGate: () => true },
    settings: context.deps.settings,
    telemetry: context.deps.telemetry.logs,
    awaitingSink: context.deps.transcript.createAwaitingStateSink(),
    transcript: context.deps.transcript,
    hostGeneration: randomUUID(), localMode: 'enforce',
    createClassifierExecutor: () => createLocalClassifier(config, library, { log: message => context.host.log(message) }),
  });
  context.onStop(() => service.stop());
  const startedAt = Date.now();
  const sweep = () => service.sweepStaleAwaitingBadges(() => context.deps.transcript.listAgentIds(), startedAt);
  void context.deps.transcript.expireAllPendingAutoReviewApprovalCards().then(sweep, sweep);
  return service;
}
