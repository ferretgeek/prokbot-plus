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

async function classifier(t, replies, options = {}) {
  const usageDirectory = await mkdtemp(join(tmpdir(), 'review-test-'));
  t.after(() => rm(usageDirectory, { recursive: true, force: true }));
  const logs = [], requests = [];
  const instance = createLocalClassifier({ apiFormat: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', usageDirectory },
    library, { log: message => logs.push(message), fetchImpl: async (url, init) => { requests.push(url); return replies.shift()(init); }, ...options });
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

test('binary_executable and truncated target enrichments block locally without calling the classifier model', async t => {
  for (const targetEnrichment of [
    { kind: 'binary_executable', path: '/workspace/bin/demo', format: 'elf', size_bytes: 1024, definition_hash: 'a'.repeat(64), truncated: true },
    { kind: 'executable', path: '/workspace/big.py', definition: 'print(1)', definition_hash: 'b'.repeat(64), truncated: true },
  ]) {
    const { instance, logs, requests } = await classifier(t, [valid]);
    const result = await instance.execute(undefined, {
      target: { action: 'run', arguments: { command: targetEnrichment.path, target_enrichment: targetEnrichment } },
      conversationContext: [{ role: 'user', content: 'Run it' }],
    });
    assert.equal(requests.length, 0);
    assert.equal(result.result.value.decision, 2);
    assert.equal(result.result.value.blockReason, '内容无法完整审查');
    assert.equal(result.result.value.proposedAllowRule, undefined);
    assert.match(logs.at(-1), /Local auto-review BLOCK/);
  }
});

// Never answers; rejects only when the request is aborted.
const silent = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));

test('a model that does not decide before the deadline blocks for user approval instead of failing', async t => {
  const { instance, logs, requests } = await classifier(t, [silent], { decisionDeadlineMs: 50 });
  const result = await instance.execute(undefined, args);
  assert.equal(requests.length, 1);
  assert.equal(result.result.value.decision, 2);
  assert.equal(result.result.value.blockReason, '自动审查没有及时得出结论');
  assert.equal(result.result.value.proposedAllowRule, undefined);
  assert.match(logs.at(-1), /Local auto-review BLOCK; model=m; reason=no-decision-within-50ms/);
});

test('cancellation by the caller still fails rather than blocking', async t => {
  const { instance, requests } = await classifier(t, [silent], { decisionDeadlineMs: 60_000 });
  const controller = new AbortController();
  const pending = instance.execute({ signal: controller.signal }, args);
  setTimeout(() => controller.abort(new Error('turn cancelled')), 20);
  await assert.rejects(pending, /turn cancelled/);
  assert.equal(requests.length, 1);
});
