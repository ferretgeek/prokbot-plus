import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalClassifier } from '../runtime/host-auto-review.mjs';

const tool = { type: 'function', function: { name: 'classify', description: 'Classify the action',
  parameters: { type: 'object', required: ['decision', 'reason', 'blocked_effect'], properties: {
    decision: { type: 'string', enum: ['ALLOW', 'BLOCK'] }, reason: { type: 'string' },
    blocked_effect: { type: 'string', enum: ['none', 'destructive_local_change', 'outbound_or_binding_external_effect'] } } } } };
const library = { CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL: tool, SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT: 'Review.',
  SmartModeClassifierResult: class { constructor(value) { Object.assign(this, value); } } };
const reply = content => new Response(JSON.stringify({ id: 'msg_1', model: 'm', stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 }, content }), { status: 200, headers: { 'content-type': 'application/json' } });
const textOnly = () => reply([{ type: 'text', text: 'Looks fine to me.' }]);
const valid = () => reply([{ type: 'tool_use', id: 't1', name: 'classify',
  input: { decision: 'ALLOW', reason: 'Read-only command', blocked_effect: 'none' } }]);

async function classifier(t, replies) {
  const usageDirectory = await mkdtemp(join(tmpdir(), 'review-test-'));
  t.after(() => rm(usageDirectory, { recursive: true, force: true }));
  const logs = [], requests = [];
  const instance = createLocalClassifier({ apiFormat: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', usageDirectory },
    library, { log: message => logs.push(message), fetchImpl: async (url, options) => { requests.push(url); return replies.shift()(); } });
  return { instance, logs, requests };
}
const args = { target: { action: 'run', arguments: { command: 'ver' } }, conversationContext: [{ role: 'user', content: 'Check the version' }] };

test('a malformed classification is retried once and then succeeds', async t => {
  const { instance, logs, requests } = await classifier(t, [textOnly, valid]);
  const result = await instance.execute(undefined, args);
  assert.equal(result.result.value.decision, 1);
  assert.equal(requests.length, 2);
  assert.match(logs[0], /retrying after: Auto-review model did not return one complete classification/);
  assert.match(logs[1], /Local auto-review ALLOW/);
});

test('a second malformed classification fails and is logged', async t => {
  const { instance, logs, requests } = await classifier(t, [textOnly, textOnly]);
  await assert.rejects(instance.execute(undefined, args), /did not return one complete classification/);
  assert.equal(requests.length, 2);
  assert.match(logs.at(-1), /Local auto-review failed/);
});

test('service errors are not retried', async t => {
  const { instance, logs, requests } = await classifier(t, [() => new Response('{"error":{"message":"overloaded"}}', { status: 529 })]);
  await assert.rejects(instance.execute(undefined, args));
  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /Local auto-review failed/);
});
