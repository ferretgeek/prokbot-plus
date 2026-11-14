import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tool = fileURLToPath(new URL('./inspect-desktop-preload.mjs', import.meta.url));

function fixture(t, bytes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-preload-fixture-')), file = path.join(dir, 'fixture.cjs');
  writeFileSync(file, bytes);
  t.after(() => { unlinkSync(file); rmdirSync(dir); });
  return expected => spawnSync(process.execPath, ['--expose-internals', tool, file, expected], { encoding: 'utf8', timeout: 5000 });
}

function rejects(result, pattern) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, pattern);
}

test('preload evidence requires the expected full digest before parsing, and valid UTF-8 JavaScript', t => {
  const invalid = Buffer.from('not valid source {');
  const run = fixture(t, invalid);
  rejects(run('a1'), /expected SHA-256/);
  rejects(run(digest(Buffer.from('other fixture'))), /mismatch/);
  rejects(run(digest(invalid)), /unexpected token/i);
  const utf8 = Buffer.from([0xff]);
  rejects(fixture(t, utf8)(digest(utf8)), /utf-8/i);
});

test('inspect syntax without executing it or promoting comments, wrong-direction or dynamic channels to known matches', t => {
  const bytes = Buffer.from(`throw new Error('fixture must not execute');
    port.sendSync('sand:boot-snapshot-sync'); port.send('sand:coordinator-port-request');
    port.invoke(prefix + 'dune-rpc:main:probe');
    // port.invoke('sand:coordinator-port-request'); port.on('sand:coordinator-port', callback);
    const unrelated = 'sand:coordinator-port';
    const frames = [{ kind: 'lifecycle', phase: 'hello', protocolVersion: 8 }, { kind: 'lifecycle', phase: 'ready', protocolVersion: configured }];`);
  const cli = fixture(t, bytes)(digest(bytes).toUpperCase());
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual(result.channels['sand:boot-snapshot-sync'], { expectedMember: 'sendSync', observedMembers: ['sendSync'] });
  assert.deepEqual(result.channels['sand:coordinator-port-request'], { expectedMember: 'invoke', observedMembers: ['send'] });
  assert.deepEqual(result.channels['sand:coordinator-port'].observedMembers, []);
  assert.deepEqual(result.channels['dune-rpc:main:probe'].observedMembers, []);
  assert.deepEqual(Object.fromEntries(result.lifecycle.map(p => [p.phase, p.literalVersion])), { hello: 8, ready: null });
  assert.deepEqual(result.literalProtocolVersions, [8]);
  assert.equal(result.legacyMethodCount, 0);
  assert.equal(result.nativeVerified, false);
  assert.equal(result.sha256, digest(bytes));
});
