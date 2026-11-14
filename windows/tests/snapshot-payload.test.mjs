import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { carveSevenZip } from '../patchers/desktop/original.mjs';
import { snapshotPayload } from '../patchers/desktop/snapshot-payload.mjs';

const pin = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'grokbot-payload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const header = Buffer.alloc(32), body = Buffer.alloc(65536 + 17, 'z');
  Buffer.from('377abcaf271c', 'hex').copy(header);
  header.writeBigUInt64LE(BigInt(body.length), 20);
  const payload = Buffer.concat([header, body]);
  const prefix = Buffer.alloc(2 * 65536 - 3);
  header.copy(prefix, 4096); // A bad candidate precedes the real header, which crosses a read boundary.
  const wrapper = Buffer.concat([prefix, payload, Buffer.from('fixture trailer')]);
  const exe = path.join(root, 'fixture.exe'), raw = path.join(root, 'fixture.7z'), scratch = path.join(root, 'scratch');
  await mkdir(scratch);
  await writeFile(exe, wrapper);
  await writeFile(raw, payload);
  return { exe, raw, scratch, wrapper, payload, supported: { archive: pin(wrapper), payload: pin(payload) } };
}

test('installer and standalone streams snapshot identical bytes and never replace existing output', async t => {
  const { exe, raw, scratch, payload, supported } = await fixture(t);
  for (const source of [exe, raw]) {
    const dest = await snapshotPayload(source, scratch, supported);
    assert.equal(dest, path.join(scratch, 'payload.7z'));
    assert.deepEqual(await readFile(dest), payload);
    await writeFile(dest, 'existing output');
    await assert.rejects(snapshotPayload(source, scratch, supported), { code: 'EEXIST' });
    assert.equal(await readFile(dest, 'utf8'), 'existing output');
    assert.deepEqual(await readdir(scratch), ['payload.7z']);
    await rm(dest);
  }
  const legacy = path.join(scratch, 'custom-name.7z');
  assert.equal(await carveSevenZip(exe, legacy, supported.payload), legacy);
  assert.deepEqual(await readFile(legacy), payload);
});

test('a wrong wrapper trailer, payload digest or input size leaves no partial output or wrapper snapshot', async t => {
  const { exe, raw, scratch, wrapper, payload, supported } = await fixture(t);
  const sentinel = path.join(scratch, 'unrelated.txt');
  await writeFile(sentinel, 'keep');
  const rejectsCleanly = async (source, pins, reason) => {
    await assert.rejects(snapshotPayload(source, scratch, pins), reason);
    assert.deepEqual(await readdir(scratch), ['unrelated.txt']);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  };
  const wrong = Buffer.from(wrapper);
  wrong[wrong.length - 1] ^= 1;
  await writeFile(exe, wrong);
  await rejectsCleanly(exe, supported, /安装包摘要不匹配/);
  await writeFile(exe, wrapper);
  const bad = { ...supported, payload: { ...supported.payload, sha256: pin(Buffer.from('wrong bytes')).sha256 } };
  await rejectsCleanly(exe, bad, /没有找到受支持/);
  await rejectsCleanly(raw, bad, /程序包摘要不匹配/);
  await rejectsCleanly(exe, { payload: supported.payload }, /缺少官方安装包/);
  await writeFile(raw, payload.subarray(0, -1));
  await rejectsCleanly(raw, supported, /程序包摘要不匹配/);
  assert.deepEqual(await readFile(exe), wrapper);
});
