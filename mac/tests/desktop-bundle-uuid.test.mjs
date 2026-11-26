import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { patchBundleExecutableUuid } from '../patchers/desktop/bundle-uuid.mjs';

function image(cpuType = 0x100000c) {
  const bytes = Buffer.alloc(96, 0x42);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpuType, 4); bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 16); bytes.writeUInt32LE(32, 20);
  bytes.writeUInt32LE(0x1b, 32); bytes.writeUInt32LE(24, 36);
  Buffer.from('4c4c44b855553144a1253279409bdc1e', 'hex').copy(bytes, 40);
  bytes.writeUInt32LE(2, 56); bytes.writeUInt32LE(8, 60);
  return bytes;
}
function universal() {
  const bytes = Buffer.alloc(0x300);
  bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x1000007, 0x100000c].entries()) {
    const at = 8 + index * 20, offset = 0x100 * (index + 1), slice = image(cpu);
    bytes.writeUInt32BE(cpu, at); bytes.writeUInt32BE(offset, at + 8); bytes.writeUInt32BE(slice.length, at + 12);
    slice.copy(bytes, offset);
  }
  return bytes;
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'prokbot-build-uuid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('variant UUIDs are reproducible, differ by bundle identity and change only LC_UUID payloads', async t => {
  const root = await directory(t), original = image(), results = [];
  for (const [index, bundle] of ['dev.grokbot.local', 'dev.grokbot.local', 'dev.grokbot.local.helper'].entries()) {
    const filename = join(root, String(index)); await writeFile(filename, original);
    const [record] = await patchBundleExecutableUuid(filename, bundle); results.push(record.after);
    assert.notEqual(record.before, record.after);
    const actual = await readFile(filename); original.subarray(40, 56).copy(actual, 40);
    assert.deepEqual(actual, original, 'code and other load commands remain unchanged');
  }
  assert.equal(results[0], results[1]); assert.notEqual(results[0], results[2]);
});

test('universal executables receive a distinct UUID for each architecture', async t => {
  const root = await directory(t), filename = join(root, 'universal'), original = universal();
  await writeFile(filename, original);
  const records = await patchBundleExecutableUuid(filename, 'dev.grokbot.local');
  assert.equal(records.length, 2); assert.notEqual(records[0].after, records[1].after);
  const actual = await readFile(filename);
  for (const offset of [0x128, 0x228]) original.subarray(offset, offset + 16).copy(actual, offset);
  assert.deepEqual(actual, original);
});

test('invalid or absent load commands and malformed universal slices leave the file untouched', async t => {
  const root = await directory(t), cases = [Buffer.alloc(4), image(), image(), image(), universal(), universal()];
  cases[1].writeUInt32LE(2, 32); // No UUID.
  cases[2].writeUInt32LE(0, 36); // Zero-length command.
  cases[3].writeUInt32LE(1024, 20); // Command range outside the slice.
  cases[4].writeUInt32BE(0x100, 36); // Overlapping architecture ranges.
  cases[5].writeUInt32LE(0, 0x200); // Invalid second architecture after a valid first.
  for (const [index, bytes] of cases.entries()) {
    const filename = join(root, String(index)); await writeFile(filename, bytes);
    await assert.rejects(patchBundleExecutableUuid(filename, 'dev.grokbot.local'), /Mach-O/);
    assert.deepEqual(await readFile(filename), bytes);
  }
});

test('real macOS executable remains runnable after UUID replacement and re-signing', { skip: process.platform !== 'darwin' }, async t => {
  const root = await directory(t), filename = join(root, 'true'); await cp('/usr/bin/true', filename);
  const records = await patchBundleExecutableUuid(filename, 'dev.grokbot.uuid-test');
  execFileSync('codesign', ['--force', '--sign', '-', filename], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', filename], { stdio: 'pipe' });
  const uuids = execFileSync('dwarfdump', ['--uuid', filename], { encoding: 'utf8' });
  for (const { before, after } of records) { assert.ok(uuids.includes(after)); assert.ok(!uuids.includes(before)); }
  execFileSync(filename);
});
