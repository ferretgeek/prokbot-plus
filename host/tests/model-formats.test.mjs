import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelSession } from '../runtime/model-session.mjs';
import { rejectedOption, deletePath, reasoningProviderOptions } from '../runtime/model-common.mjs';
import { anthropicEndpoint, anthropicOptions, convertAnthropicMessages } from '../runtime/anthropic-messages.mjs';
import { convertResponsesInput, responsesOptions } from '../runtime/openai-responses.mjs';
import { convertChatMessages, maxTokensParameter } from '../runtime/openai-chat.mjs';
import { effortLevels } from '../runtime/model-policy.mjs';

const anthropicTag = model => ({ providerOptions: reasoningProviderOptions({ format: 'anthropic', model }) });
const responsesTag = (model, itemId) => ({ providerOptions: reasoningProviderOptions({ format: 'openai-responses', model, summarized: true, itemId }) });
const chatTag = model => ({ providerOptions: reasoningProviderOptions({ format: 'openai', model }) });

function sse(events, { done = false } = {}) {
  const text = events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' } });
}
const failure = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

/** Run one session turn with scripted HTTP responses; returns stream parts, response and requests. */
async function turn(apiFormat, replies, { model = 'm', effort, messages, tools = [], efforts } = {}) {
  const requests = [];
  const session = createModelSession({ apiFormat, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model,
    policy: efforts ? { models: [{ id: model, efforts }] } : undefined,
    fetchImpl: async (url, options) => { requests.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return replies.shift()(); },
    selectRequest: async () => ({ model, effort }) });
  const result = session.getExecutor(messages ?? [{ role: 'user', content: 'Weather in Paris?' }]).stream({}, 'inv', tools);
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  return { parts, response: await result.response, usage: await result.usage, requests };
}
const weatherTool = [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];

// ---- Shared ---------------------------------------------------------------------------

test('rejected optional parameters are recognized from param or message', () => {
  assert.equal(rejectedOption({ status: 400, message: "Unsupported parameter: 'max_tokens' is not supported with this model." }, ['max_tokens', 'stream_options']), 'max_tokens');
  assert.equal(rejectedOption({ status: 400, message: 'bad', param: 'reasoning.summary' }, ['reasoning.summary', 'include']), 'reasoning.summary');
  assert.equal(rejectedOption({ status: 400, message: 'fallbacks: Extra inputs are not permitted' }, ['fallbacks']), 'fallbacks');
  assert.equal(rejectedOption({ status: 429, message: 'max_tokens' }, ['max_tokens']), undefined);
  const body = { reasoning: { summary: 'auto' }, include: [] };
  deletePath(body, 'reasoning.summary');
  assert.deepEqual(body, { include: [] });
});

test('effort reference levels include minimal and follow Claude generations', () => {
  assert.deepEqual(effortLevels('gpt-5'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(effortLevels('claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortLevels('claude-sonnet-5-5'), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortLevels('claude-opus-4-6'), ['none', 'low', 'medium', 'high', 'max']);
});

// ---- Anthropic Messages ---------------------------------------------------------------

test('anthropic endpoint accepts host, /v1 root and full messages URL', () => {
  assert.equal(anthropicEndpoint('https://llm.example.com'), 'https://llm.example.com/v1/messages');
  assert.equal(anthropicEndpoint('https://llm.example.com/v1/'), 'https://llm.example.com/v1/messages');
  assert.equal(anthropicEndpoint('https://llm.example.com/v1/messages'), 'https://llm.example.com/v1/messages');
  assert.equal(anthropicEndpoint('https://llm.example.com/v1', 'models'), 'https://llm.example.com/v1/models');
});

test('anthropic effort maps to each Claude generation', () => {
  assert.deepEqual(anthropicOptions('claude-opus-5-5', { effort: 'high' }), { max_tokens: 64000,
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' }, fallbacks: 'default' });
  assert.deepEqual(anthropicOptions('claude-opus-5-5', { effort: 'none' }).output_config, { effort: 'low' });
  assert.deepEqual(anthropicOptions('claude-sonnet-5-5', { effort: 'none' }).thinking, { type: 'between_tools' });
  assert.deepEqual(anthropicOptions('claude-opus-4-7', { effort: 'none' }).thinking, { type: 'disabled' });
  assert.deepEqual(anthropicOptions('claude-opus-4-6', { effort: 'xhigh' }).output_config, { effort: 'high' });
  assert.deepEqual(anthropicOptions('claude-opus-4-8', { effort: 'minimal' }).output_config, { effort: 'low' });
  const legacy = anthropicOptions('claude-sonnet-4-5-20250929', { effort: 'high' });
  assert.equal(legacy.thinking.type, 'enabled');
  assert.ok(legacy.thinking.budget_tokens < legacy.max_tokens);
  assert.equal(anthropicOptions('claude-haiku-4-5', {}).thinking, undefined);
  assert.equal(anthropicOptions('claude-opus-5-5', { maxTokens: 500_000 }).max_tokens, 128000);
});

test('anthropic history keeps tool results, screenshots, documents and only Anthropic thinking', () => {
  const { system, messages, replayedThinking } = convertAnthropicMessages([
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'file', data: 'JVBERg==', mimeType: 'application/pdf', filename: 'a.pdf' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'Need a screenshot.', signature: 'sig-1', ...anthropicTag('claude-opus-5-5') },
      { type: 'reasoning', text: 'GPT summary', signature: 'enc', ...responsesTag('gpt-5.5', 'rs_1') },
      { type: 'text', text: 'Checking.' },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'screenshot', args: {} },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'screenshot', result: undefined,
      experimental_content: [{ type: 'text', text: 'captured' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }] },
    { role: 'user', content: 'Thanks' },
  ]);
  assert.deepEqual(system, [{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(replayedThinking, true);
  assert.deepEqual(messages[0].content[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' }, title: 'a.pdf' });
  assert.deepEqual(messages[1].content.map(block => block.type), ['thinking', 'text', 'tool_use']);
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.deepEqual(messages[2].content[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
});

test('anthropic thinking without its signature strips every thinking block', () => {
  const { messages, replayedThinking } = convertAnthropicMessages([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'x', signature: 's', ...anthropicTag('claude-opus-5-5') }, { type: 'text', text: 'b' }] },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'y', ...anthropicTag('claude-opus-5-5') }, { type: 'text', text: 'd' }] },
    { role: 'user', content: 'e' },
  ]);
  assert.equal(replayedThinking, false);
  assert.ok(messages.every(item => item.content.every(block => block.type !== 'thinking')));
});

test('anthropic stream yields tagged reasoning, its signature, text, tool call and usage', async () => {
  const { parts, response, usage, requests } = await turn('anthropic', [() => sse([
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Use the tool.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ])], { model: 'claude-opus-5-5', effort: 'high', tools: weatherTool });
  assert.equal(requests[0].url, 'https://api.example.com/v1/messages');
  assert.equal(requests[0].headers.get('x-api-key'), 'k');
  assert.equal(requests[0].body.output_config.effort, 'high');
  assert.deepEqual(parts.filter(part => part.type === 'reasoning').map(part => part.textDelta), ['Use the tool.']);
  assert.equal(parts.find(part => part.type === 'reasoning').providerOptions.cursor.modelName, 'claude-opus-5-5');
  assert.deepEqual(parts.find(part => part.type === 'reasoning-signature'), { type: 'reasoning-signature', signature: 'sig' });
  assert.deepEqual(parts.find(part => part.type === 'tool-call'), { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'get_weather', args: { city: 'Paris' } });
  assert.equal(parts.at(-1).finishReason, 'tool-calls');
  const reasoning = response.messages[0].content[0];
  assert.equal(reasoning.signature, 'sig');
  assert.equal(reasoning.providerOptions.grokbot.format, 'anthropic');
  assert.deepEqual(usage, { promptTokens: 15, completionTokens: 42, totalTokens: 57 });
});

test('anthropic retries without rejected fallbacks and without stale thinking', async () => {
  const done = () => sse([{ type: 'message_start', message: { id: 'm', usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]);
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'x', signature: 's', ...anthropicTag('claude-opus-5-5') }, { type: 'text', text: 'b' }] }, { role: 'user', content: 'c' }];
  const { requests } = await turn('anthropic', [
    () => failure(400, { type: 'invalid_request_error', message: 'fallbacks: Extra inputs are not permitted' }),
    () => failure(400, { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block.' }),
    done,
  ], { model: 'claude-opus-5-5', messages: history });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].body.fallbacks, undefined);
  assert.equal(requests[1].headers.get('anthropic-beta'), null);
  assert.ok(requests[1].body.messages[1].content.some(block => block.type === 'thinking'));
  assert.ok(requests[2].body.messages[1].content.every(block => block.type !== 'thinking'));
});

test('anthropic refusal and truncation surface as model errors', async () => {
  const end = reason => () => sse([{ type: 'message_start', message: { id: 'm', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: reason, ...(reason === 'refusal' ? { stop_details: { category: 'cyber' } } : {}) }, usage: { output_tokens: 0 } }, { type: 'message_stop' }]);
  await assert.rejects(turn('anthropic', [end('refusal')]), /declined this request \(cyber\)/);
  await assert.rejects(turn('anthropic', [end('max_tokens')]), /max_tokens/);
});

// ---- OpenAI Responses -----------------------------------------------------------------

test('responses options request summaries and encrypted reasoning statelessly', () => {
  assert.deepEqual(responsesOptions('gpt-5.5', { effort: 'high' }), { store: false, parallel_tool_calls: true,
    reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'] });
  assert.deepEqual(responsesOptions('gpt-5.5', { effort: 'none' }).reasoning, { effort: 'none' });
  assert.equal(responsesOptions('gpt-4.1-mini', { efforts: ['none'] }).reasoning, undefined);
  assert.equal(responsesOptions('grok-4.7', { effort: 'minimal', maxTokens: 900 }).max_output_tokens, 900);
});

test('responses input keeps instructions, media, phase and own encrypted reasoning in order', () => {
  const { instructions, input, replayed } = convertResponsesInput([
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', image: 'QUJD', mimeType: 'image/png' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'Plan', signature: 'enc-1', ...responsesTag('gpt-5.5', 'rs_1') },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'screenshot', args: {} },
      { type: 'reasoning', text: 'Claude', signature: 'sig', ...anthropicTag('claude-opus-5-5') },
      { type: 'reasoning', text: 'Other model', signature: 'enc-2', ...responsesTag('gpt-6-sol', 'rs_2') },
      { type: 'text', text: 'Done', providerOptions: { grokbot: { phase: 'final_answer' } } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'screenshot', result: 'ok',
      experimental_content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }] },
    { role: 'system', content: 'Mid-conversation note' },
  ], { model: 'gpt-5.5' });
  assert.equal(instructions, 'Be helpful.');
  assert.equal(replayed, 1);
  assert.deepEqual(input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,QUJD', detail: 'auto' });
  assert.deepEqual(input.slice(1, 4).map(item => item.type), ['reasoning', 'function_call', 'message']);
  assert.deepEqual(input[1], { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'enc-1' });
  assert.deepEqual(input[3], { type: 'message', role: 'assistant', content: 'Done', phase: 'final_answer' });
  assert.deepEqual(input[4].output, [{ type: 'input_text', text: 'ok' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }]);
  assert.deepEqual(input[5], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Mid-conversation note' }] });
  const legacy = convertResponsesInput([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', result: 'ok',
    experimental_content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }] }], { inlineToolImages: false });
  assert.deepEqual(legacy.input.map(item => item.type), ['function_call_output', 'message']);
});

test('responses stream yields summarized reasoning, signature, text and tool calls in output order', async () => {
  const { parts, response, usage, requests } = await turn('openai-responses', [() => sse([
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Need weather.' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'Call tool.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Need weather.' }, { type: 'summary_text', text: 'Call tool.' }], encrypted_content: 'enc' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', phase: 'commentary' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Checking.' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"city":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"Paris"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' } },
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', status: 'completed',
      usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 8 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 50 } } },
  ])], { model: 'gpt-5.5', effort: 'xhigh', tools: weatherTool });
  assert.equal(requests[0].url, 'https://api.example.com/v1/responses');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer k');
  assert.deepEqual(requests[0].body.reasoning, { effort: 'xhigh', summary: 'auto' });
  assert.equal(requests[0].body.store, false);
  assert.deepEqual(requests[0].body.tools[0], { type: 'function', name: 'get_weather', description: 'Weather', parameters: weatherTool[0].parameters, strict: false });
  assert.deepEqual(parts.filter(part => part.type === 'reasoning').map(part => part.textDelta), ['Need weather.', '\n\nCall tool.']);
  assert.equal(parts.find(part => part.type === 'reasoning').providerOptions.cursor.isAlreadySummarizedThinking, true);
  assert.deepEqual(parts.find(part => part.type === 'reasoning-signature'), { type: 'reasoning-signature', signature: 'enc' });
  const content = response.messages[0].content;
  assert.deepEqual(content.map(part => part.type), ['reasoning', 'text', 'tool-call']);
  assert.equal(content[0].text, 'Need weather.\n\nCall tool.');
  assert.equal(content[0].providerOptions.grokbot.itemId, 'rs_1');
  assert.equal(content[1].providerOptions.grokbot.phase, 'commentary');
  assert.deepEqual(content[2].args, { city: 'Paris' });
  assert.deepEqual(usage, { promptTokens: 20, completionTokens: 30, totalTokens: 50 });
});

test('responses incomplete and failed turns surface as model errors', async () => {
  await assert.rejects(turn('openai-responses', [() => sse([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }])]), /max_output_tokens/);
  await assert.rejects(turn('openai-responses', [() => sse([{ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window' } } }])]),
    error => error.code === 'context_length_exceeded');
});

test('responses retries without rejected summaries and stale encrypted reasoning', async () => {
  const done = () => sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_text.delta', output_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
    { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } } }]);
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'x', signature: 'enc', ...responsesTag('gpt-5.5', 'rs') }, { type: 'text', text: 'b' }] }, { role: 'user', content: 'c' }];
  const { requests } = await turn('openai-responses', [
    () => failure(400, { message: 'The encrypted content for item rs could not be verified.', type: 'invalid_request_error' }),
    () => failure(400, { message: "Unsupported parameter: 'reasoning.summary'", param: 'reasoning.summary', type: 'invalid_request_error' }),
    done,
  ], { model: 'gpt-5.5', effort: 'high', messages: history });
  assert.equal(requests[0].body.input.filter(item => item.type === 'reasoning').length, 1);
  assert.equal(requests[1].body.input.filter(item => item.type === 'reasoning').length, 0);
  assert.deepEqual(requests[2].body.reasoning, { effort: 'high' });
});

// ---- OpenAI Chat Completions ----------------------------------------------------------

test('chat uses max_completion_tokens for OpenAI reasoning models and replays only its own reasoning', () => {
  assert.equal(maxTokensParameter('gpt-5.5'), 'max_completion_tokens');
  assert.equal(maxTokensParameter('deepseek-v4.1-flash'), 'max_tokens');
  assert.equal(maxTokensParameter('deepseek-v4.1-flash', new Set(['max_tokens'])), 'max_completion_tokens');
  const messages = convertChatMessages([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'own', ...chatTag('deepseek-v4.1-flash') },
      { type: 'reasoning', text: 'claude', signature: 's', ...anthropicTag('claude-opus-5-5') }, { type: 'text', text: 'b' }] },
  ], { model: 'deepseek-v4.1-flash' });
  assert.equal(messages[1].reasoning_content, 'own');
});

test('chat stream reads reasoning_content, reasoning and refusal deltas', async () => {
  const { parts, response, requests } = await turn('openai', [() => sse([
    { id: 'c1', model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { reasoning_content: 'Think. ' } }] },
    { id: 'c1', choices: [{ index: 0, delta: { reasoning: 'More.' } }] },
    { id: 'c1', choices: [{ index: 0, delta: { content: 'Answer' } }] },
    { id: 'c1', choices: [{ index: 0, delta: { refusal: ' (partly declined)' }, finish_reason: 'stop' }] },
    { id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  ], { done: true })], { model: 'deepseek-v4.1-flash', effort: 'high' });
  assert.equal(requests[0].body.reasoning_effort, 'high');
  assert.deepEqual(requests[0].body.thinking, { type: 'enabled' });
  assert.deepEqual(parts.filter(part => part.type === 'reasoning').map(part => part.textDelta), ['Think. ', 'More.']);
  const content = response.messages[0].content;
  assert.equal(content[0].providerOptions.grokbot.format, 'openai');
  assert.equal(content[1].text, 'Answer (partly declined)');
});

test('chat swaps the output limit parameter when the service rejects it', async () => {
  const done = () => sse([{ id: 'c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }], { done: true });
  const requests = [];
  const session = createModelSession({ apiFormat: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-5.5',
    fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return requests.length === 1
      ? failure(400, { message: "Unsupported parameter: 'max_completion_tokens'", param: 'max_completion_tokens' }) : done(); } });
  const result = session.getExecutor([{ role: 'user', content: 'x' }]).stream({}, 'i', [], { maxTokens: 500 });
  for await (const part of result.fullStream) void part;
  assert.equal(requests[0].max_completion_tokens, 500);
  assert.equal(requests[1].max_tokens, 500);
  assert.equal(requests[1].max_completion_tokens, undefined);
});

// ---- Reasoning without readable text --------------------------------------------------

test('signed thinking without text is kept as a redacted part and replayed as thinking', async () => {
  const { parts, response } = await turn('anthropic', [() => sse([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-empty' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ])], { model: 'claude-opus-5-5' });
  assert.equal(parts.filter(part => part.type === 'reasoning').length, 0);
  const redacted = response.messages[0].content[0];
  assert.equal(redacted.type, 'redacted-reasoning');
  assert.equal(redacted.data, 'sig-empty');
  const { messages } = convertAnthropicMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: [redacted, { type: 'text', text: 'ok' }] }, { role: 'user', content: 'b' }]);
  assert.deepEqual(messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-empty' });
});

test('encrypted reasoning without a summary is kept as a redacted part and replayed', async () => {
  const { parts, response } = await turn('openai-responses', [() => sse([
    { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_9' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'enc-9' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
    { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } } },
  ])], { model: 'gpt-5.5', effort: 'high' });
  assert.equal(parts.find(part => part.type === 'redacted-reasoning').data, 'enc-9');
  const redacted = response.messages[0].content[0];
  assert.equal(redacted.type, 'redacted-reasoning');
  const { input } = convertResponsesInput([{ role: 'user', content: 'a' }, { role: 'assistant', content: [redacted, { type: 'text', text: 'ok' }] }], { model: 'gpt-5.5' });
  assert.deepEqual(input[1], { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'enc-9' });
});
