import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitToolCallTurn, recordToolCallOrder } from '../runtime/reliability/tool-order.mjs';
import { serializeToolCalls } from '../runtime/model-common.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (toolCallId, toolName) => ({ type: 'tool-call', toolCallId, toolName, args: {} });

/** Run like the journal does: wait for the turn, execute, release. */
async function run(id, log, ms, signal) {
  const release = await awaitToolCallTurn(id, signal);
  try { log.push(`start ${id}`); await delay(ms); log.push(`end ${id}`); }
  finally { release(); }
}

test('messages from one response run in written order even when started in reverse', async () => {
  serializeToolCalls([call('m1', 'SendToUser'), call('s1', 'WebSearch'), call('m2', 'SendToUser'), call('m3', 'SendToAgent')]);
  const log = [];
  // The longest message is written first; later ones start earlier and would finish first.
  await Promise.all([run('m3', log, 1), run('m2', log, 1), run('s1', log, 30), run('m1', log, 20)]);
  const messages = log.filter(line => line.startsWith('start m'));
  assert.deepEqual(messages, ['start m1', 'start m2', 'start m3']);
  // Each message starts only after the previous one finished.
  assert.ok(log.indexOf('end m1') < log.indexOf('start m2'));
  assert.ok(log.indexOf('end m2') < log.indexOf('start m3'));
  // Other tools are not delayed by messages.
  assert.equal(log[0], 'start s1');
});

test('separate responses and unrecorded calls do not wait', async () => {
  recordToolCallOrder([{ toolCallId: 'a1', toolName: 'SendToUser' }]);
  recordToolCallOrder([{ toolCallId: 'b1', toolName: 'SendToUser' }]);
  const log = [];
  await Promise.all([run('b1', log, 1), run('a1', log, 10), run('unknown', log, 1)]);
  assert.equal(log.indexOf('start b1') < log.indexOf('end a1'), true);
  assert.ok(log.includes('start unknown'));
});

test('a predecessor that never runs only delays the next message up to the limit', async () => {
  recordToolCallOrder([{ toolCallId: 'lost', toolName: 'SendToUser' }, { toolCallId: 'next', toolName: 'SendToUser' }]);
  const started = Date.now();
  const release = await awaitToolCallTurn('next', undefined, { maxWaitMs: 50 });
  release();
  assert.ok(Date.now() - started >= 45);
  (await awaitToolCallTurn('lost'))();
});

test('cancellation stops waiting for an earlier message', async () => {
  recordToolCallOrder([{ toolCallId: 'first', toolName: 'SendToUser' }, { toolCallId: 'second', toolName: 'SendToUser' }]);
  const controller = new AbortController();
  const releaseFirst = await awaitToolCallTurn('first');
  const waiting = awaitToolCallTurn('second', controller.signal);
  setTimeout(() => controller.abort(), 10);
  const started = Date.now();
  (await waiting)();
  assert.ok(Date.now() - started < 1000);
  releaseFirst();
});
