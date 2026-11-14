import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { inspectRecipe } from './recipe-pin.mjs';

test('offline verification checks the compressed bytes and both manifest and recipe metadata', () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const r = { schema: 'grokbot-bytepatch/v1', sourceSha256: sha('a'), targetSha256: sha('ab'),
    sourceBytes: 1, targetBytes: 2, ops: [['copy', 0, 1], ['add', 'Yg==']] };
  const encode = obj => gzipSync(JSON.stringify(obj));
  const bytes = encode(r), item = { targetBytes: 2, addedBytes: 1, sha256: sha(bytes) };
  assert.deepEqual(inspectRecipe(bytes, 'fixture', item, sha('a')), { input: sha('a'), output: sha('ab') });
  assert.throws(() => inspectRecipe(bytes, 'fixture', { ...item, sha256: sha('other') }), /recipe bytes/);
  assert.throws(() => inspectRecipe(bytes, 'fixture', item, sha('other')), /source pin/);
  assert.throws(() => inspectRecipe(bytes, 'fixture', { ...item, addedBytes: 0 }));
  assert.throws(() => inspectRecipe(encode({ ...r, ops: [['copy', 1, 1]] }), 'fixture', {}), /COPY/);
  assert.throws(() => inspectRecipe(encode({ ...r, ops: [['add', '@@']] }), 'fixture', {}), /encoding/);
});
