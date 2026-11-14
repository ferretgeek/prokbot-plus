import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { replayCoordinator } from '../tools/compat/1.1.0/coordinator-replay.mjs';

const tool = fileURLToPath(new URL('../tools/compat/1.1.0/coordinator-replay.mjs', import.meta.url));
const official = process.env.PROKBOT_WINDOWS_110_ASAR;
const stock = { skip: official === undefined ? 'PROKBOT_WINDOWS_110_ASAR not supplied; genuine renderer evidence requires the stock Windows 1.1.0 ASAR' : false };
function cli(file) {
  const env = { ...process.env, UV_THREADPOOL_SIZE: '1' };
  if (file === undefined) delete env.PROKBOT_WINDOWS_110_ASAR;
  else env.PROKBOT_WINDOWS_110_ASAR = file;
  const r = spawnSync(process.execPath, ['--single-threaded', '--v8-pool-size=1', '--max-old-space-size=64', '--expose-internals', tool],
    { env, encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024, windowsHide: true });
  assert.ifError(r.error); return r;
}
function stockOutput() {
  const result = cli(official); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); return result.stdout;
}
let output;
const report = () => JSON.parse(output ??= stockOutput());

function withReads(t, hooks, run) {
  const mocks = Object.entries(hooks).map(([key, fn]) => t.mock.method(fs, key, fn));
  try { syncBuiltinESMExports(); return run(); }
  finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
}

test('no implicit input: missing, explicit empty and nonexistent paths cannot yield a transcript', () => {
  for (const file of [undefined, '', path.join(os.tmpdir(), `absent-${randomUUID()}.asar`)]) {
    const result = cli(file); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, file ? /ENOENT/ : /PROKBOT_WINDOWS_110_ASAR/);
  }
});

test('refuses network paths and device names before opening anything', t => {
  withReads(t, { openSync: () => assert.fail('no attempt to open a nonlocal input') }, () => {
    for (const file of ['//fixture/share', '\\\\fixture\\share', '\\\\?\\UNC\\fixture\\share', 'fixture://archive'])
      assert.throws(() => replayCoordinator(file), /local Windows 1\.1\.0 ASAR/);
  });
});

test('wrong header digest stops before JSON, member reads, Acorn or VM; closes the descriptor', t => {
  const positions = [], closed = [], header = Buffer.alloc(245816), prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4); prefix.writeUInt32LE(header.length, 4);
  header.writeUInt32LE(header.length - 4); header.writeUInt32LE(1, 4); header.write('{', 8); // Intentionally invalid JSON.
  const execution = t.mock.method(vm.Script.prototype, 'runInContext', () => assert.fail('VM on unverified input'));
  withReads(t, { openSync: (p, flags) => { assert.equal(flags, 'r'); return 91; },
    fstatSync: () => ({ isFile: () => true, size: 57252462 }), closeSync: fd => closed.push(fd),
    readSync: (fd, out, offset, length, pos) => {
      assert.equal(fd, 91); positions.push(pos); assert.ok(pos === 0 || pos === 8);
      return (pos === 0 ? prefix : header).copy(out, offset, 0, length);
    } }, () => assert.throws(() => replayCoordinator('synthetic.asar'), /header digest mismatch/));
  assert.deepEqual(positions, [0, 8]); assert.deepEqual(closed, [91]); assert.equal(execution.mock.callCount(), 0);
});

test('stock provenance, exact bounded spans and unchanged reproducible JSON; no native or effectful execution', stock, () => {
  const r = report(); assert.equal(output, stockOutput());
  assert.equal(r.evidence, 'isolated-component'); assert.equal(r.platform, 'windows-x64'); assert.equal(r.version, '1.1.0');
  assert.equal(r.input.archiveSha256, 'ae8f0a14fe65f421881f96fdcb66aaaaed8b28806f79d5239dbefec9ef2ea972');
  assert.equal(r.input.headerSha256, '9fb5f015b88ae9ae5da2033aa1c447b6ea57c26a53bf04bf56b4f4219d4baa6a');
  assert.deepEqual(r.input.members[0], { member: 'dist/renderer/assets/index.eager-app-BwKPFs1J.js', bytes: 5332700,
    sha256: '674d104b22e65cd64f9b20534c561aa3ee804f5c7a7ac1f95a95fb1dc6ca4d24' });
  assert.equal(r.input.members.length, 2); assert.equal(r.static.ranges.bqr.bytes, 3180);
  for (const id of ['bqr', 'Tqr', 'oqr', 'sqr', 'cqr', 'lqr', 'cm', 'fqr', 'guardImports', 'guardExports']) assert.ok(r.static.ranges[id]);
  assert.ok(Object.values(r.static.ranges).every(s => s.bytes > 0 && s.bytes <= 7398 && /^[0-9a-f]{64}$/.test(s.sha256)));
  assert.deepEqual(r.limits, { fixtureOnly: true, sendPromptArgs: 'Project Host fixture fields: forwarded, not validated as an official schema.',
    lifecycleEffects: 'AST-traced, not executed', portEvents: 'synthetic, not delivered',
    moduleExecuted: false, nativePreloadExecuted: false, coordinatorInstantiated: false, nativeVerified: false });
});

test('official renderer hello, three method declarations and successful typed synthetic replies', stock, () => {
  const { static: s, isolated: { transcript: { normal, nullSendResult } } } = report();
  const methodNames = ['listAgents', 'getAgentTranscriptTail', 'sendPrompt'];
  assert.equal(s.sender, 'Tqr -> bqr -> port.postMessage'); assert.equal(s.protocolVersion, 3);
  assert.deepEqual(s.frameKinds, ['lifecycle', 'request', 'cancel', 'reply', 'event']);
  assert.deepEqual(s.methods, { listAgents: { args: 'none', reply: 'array' }, getAgentTranscriptTail: { args: 'object', reply: 'transcript-page' },
    sendPrompt: { args: 'object', reply: 'send-result' } });
  assert.deepEqual(normal.hello, { kind: 'lifecycle', phase: 'hello', protocolVersion: 3 });
  assert.deepEqual(normal.ready, { frame: { kind: 'lifecycle', phase: 'ready', protocolVersion: 3 }, nextPhase: 'serving' });
  assert.deepEqual(normal.calls.map(c => c.outbound.method), methodNames);
  for (const [i, { outbound, inbound, container }] of normal.calls.entries()) {
    assert.equal(outbound.kind, 'request'); assert.equal(outbound.requestId, `r-${i + 1}`);
    assert.equal(inbound.kind, 'reply'); assert.equal(inbound.requestId, outbound.requestId); assert.equal(inbound.outcome.status, 'ok');
    assert.deepEqual(container, { valid: true, value: inbound.outcome.value });
  }
  assert.deepEqual(normal.calls[0].outbound.args, {}); assert.ok(!Object.hasOwn(normal.calls[0].outbound, 'demand'));
  assert.ok(Array.isArray(normal.calls[0].container.value)); assert.ok(Array.isArray(normal.calls[1].container.value.entries));
  assert.deepEqual(normal.calls[2].outbound.args, { agentId: 'fixture-agent', prompt: 'offline fixture', clientNonce: 'fixture-nonce-1', directAddressedAcceptance: true });
  assert.equal(normal.calls[2].outbound.demand, 'person'); assert.deepEqual(nullSendResult, { valid: true, valueKind: 'undefined' });
});

test('duplicate ready and numeric wrong version parse but breach session policy; malformed frame and container are distinct', stock, () => {
  const { negative } = report().isolated.transcript;
  for (const [item, version] of [[negative.duplicateReady, 3], [negative.wrongVersion, 4]]) {
    assert.equal(item.frame.protocolVersion, version); assert.equal(item.nextPhase, 'settled');
    assert.deepEqual(Object.keys(item.outbound), ['kind', 'phase', 'reason', 'detail']);
    assert.equal(item.outbound.kind, 'lifecycle'); assert.equal(item.outbound.phase, 'shutdown');
    assert.equal(item.outbound.reason, 'protocol-error'); assert.ok(item.outbound.detail.length > 0);
  }
  assert.notEqual(negative.duplicateReady.outbound.detail, negative.wrongVersion.outbound.detail);
  assert.equal(negative.malformedFrames.length, 11); const ids = negative.malformedFrames.map(c => c.caseId);
  assert.ok(ids.includes('ready/string-version') && ids.includes('shutdown/empty-detail') && ids.includes('cancel/empty-id'));
  for (const c of negative.malformedFrames) { assert.equal(c.rejection.code, 'malformed-frame'); assert.ok(c.rejection.detail.length > 0); }
  assert.deepEqual(negative.wrongContainers.map(c => c.method), ['listAgents', 'getAgentTranscriptTail', 'getAgentTranscriptTail', 'getAgentTranscriptTail', 'sendPrompt']);
  for (const c of negative.wrongContainers) { assert.deepEqual(c.container, { valid: false }); assert.equal(c.staticCode, 'source/malformed-reply'); }
});

test('transport and transcript events pass the envelope independently of their state/source payload codes', stock, () => {
  const { static: s, isolated: { transcript: { normal, negative } } } = report();
  assert.deepEqual(s.eventCodes, { state: ['connected', 'down'], source: ['gateway', 'server'] });
  assert.deepEqual(normal.events.map(e => e.frame.family), ['coordinator-transport-state', 'coordinator-transport-state', 'coordinator-transcript-source', 'coordinator-transcript-source']);
  assert.deepEqual(normal.events.map(e => e.decoded), [{ state: 'connected' }, { state: 'down' }, { source: 'server' }, { source: 'gateway' }]);
  assert.deepEqual(negative.state.map(e => e.frame.payload.state), ['online', 'reconnecting', 'disconnected', 3]);
  assert.ok(negative.state.every(e => e.decoded === null)); assert.equal(negative.transcriptSource.decoded, null);
});

test('signal cancellation keeps the request ID; disposal, peer shutdown and bare close remain distinct', stock, () => {
  const { static: s, isolated: { transcript: { cancellation: c, closure } } } = report();
  assert.deepEqual(s.abort, { kind: 'cancel', rpcMethod: false, failureCode: 'source/cancelled' });
  assert.equal(c.preAbortedGuard, true); assert.equal(c.liveSignalGuard, false);
  assert.deepEqual(c.pendingGuards, { active: true, alreadyReplied: false, differentId: false, settled: false });
  assert.equal(c.outboundRequest.method, 'sendPrompt');
  assert.deepEqual(c.outboundRequest.args, { agentId: 'fixture-agent', prompt: 'cancel fixture', clientNonce: 'fixture-nonce-2', directAddressedAcceptance: true });
  assert.deepEqual(c.outboundCancel, { kind: 'cancel', requestId: c.outboundRequest.requestId });
  assert.equal(c.inboundFailure.requestId, c.outboundCancel.requestId); assert.equal(c.inboundFailure.outcome.status, 'failed');
  assert.equal(c.inboundFailure.outcome.failure.code, 'cancelled'); assert.equal(c.staticFailureCode, 'source/cancelled');
  const shutdown = { kind: 'lifecycle', phase: 'shutdown', reason: 'requested', detail: null };
  assert.deepEqual(closure.localDisposeFrame, shutdown); assert.deepEqual(closure.peerShutdownFrame, shutdown);
  assert.deepEqual(closure.portClosed, { outboundFrames: [], invokesCleanup: true, staticPendingFailureCode: 'source/transport-failure',
    staticStateNotification: 'down', repeatedCloseInvokesCleanup: false });
  assert.equal(s.close.clearsPending, true); assert.equal(s.close.detachesAbort, true);
  assert.equal(closure.lateReply.frame.requestId, closure.pendingRequest.requestId);
  assert.equal(closure.lateReply.ignoreWhileServing, false); assert.equal(closure.lateReply.ignoreAfterClose, true);
});

test('in-memory corruption of either renderer member or only the archive stream rejects before the VM', stock, t => {
  const original = fs.readSync;
  const execution = t.mock.method(vm.Script.prototype, 'runInContext', () => assert.fail('bad input reached VM'));
  for (const [bufferSize, reason] of [[5332700, /app member digest mismatch/], [415503, /common member digest mismatch/], [256 * 1024, /archive digest mismatch/]]) {
    let flipped = false;
    withReads(t, { readSync(fd, buffer, offset, length, position) {
      const n = original(fd, buffer, offset, length, position);
      if (!flipped && n && buffer.length === bufferSize) { buffer[offset] ^= 1; flipped = true; }
      return n;
    } }, () => assert.throws(() => replayCoordinator(official), reason));
    assert.equal(flipped, true);
  }
  assert.equal(execution.mock.callCount(), 0);
});
