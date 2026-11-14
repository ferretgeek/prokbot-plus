import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const fingerprint = /^[0-9a-f]{64}$/;

// This checks the release inputs against one another, not against a downloaded original.
export function inspectRecipe(buffer, label, entry, sourcePin) {
  if (entry.sha256 !== undefined) {
    assert.equal(createHash('sha256').update(buffer).digest('hex'), entry.sha256, `wrong recipe bytes: ${label}`);
  }
  const r = JSON.parse(gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 }));
  assert.equal(r.schema, 'grokbot-bytepatch/v1', label);
  for (const field of ['sourceSha256', 'targetSha256']) assert.match(r[field], fingerprint, label);
  for (const field of ['sourceBytes', 'targetBytes']) assert.ok(Number.isSafeInteger(r[field]) && r[field] >= 0, label);
  if (sourcePin !== undefined) assert.equal(r.sourceSha256, sourcePin, `stale source pin: ${label}`);
  let total = 0, added = 0;
  for (const op of r.ops) {
    if (op[0] === 'copy') {
      const [, at, length] = op;
      assert.ok(op.length === 3 && Number.isSafeInteger(at) && at >= 0 && Number.isSafeInteger(length) &&
        length > 0 && length <= r.sourceBytes - at, `invalid COPY: ${label}`);
      total += length;
    } else {
      assert.ok(op[0] === 'add' && op.length === 2 && typeof op[1] === 'string', `invalid ADD: ${label}`);
      const data = Buffer.from(op[1], 'base64');
      assert.equal(data.toString('base64'), op[1], `invalid ADD encoding: ${label}`);
      total += data.length; added += data.length;
    }
    assert.ok(total <= r.targetBytes, `target overflow: ${label}`);
  }
  assert.equal(total, r.targetBytes, `wrong target size: ${label}`);
  if (entry.targetBytes !== undefined) assert.equal(total, entry.targetBytes, label);
  if (entry.addedBytes !== undefined) assert.equal(added, entry.addedBytes, label);
  return { input: r.sourceSha256, output: r.targetSha256 };
}
