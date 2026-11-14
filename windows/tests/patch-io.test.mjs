import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { carveSevenZip, unpackOriginal } from '../patchers/desktop/original.mjs';
import { checkOutputLocation, publishBuild, writeNewFile, writeSetup } from '../patchers/desktop/output.mjs';

async function disposable(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'grokbot-patch-io-'));
  assert.equal(path.dirname(await realpath(root)), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('carving never overwrites the wrapper or an existing extraction', async t => {
  const root = await disposable(t);
  const payload = Buffer.alloc(32); Buffer.from('377abcaf271c', 'hex').copy(payload);
  const wrapper = Buffer.concat([Buffer.from('synthetic wrapper'), payload]);
  const pin = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const source = path.join(root, 'sample.exe'), dest = path.join(root, 'keep.7z');
  await writeFile(source, wrapper); await writeFile(dest, 'existing input');
  for (const target of [source, dest])
    await assert.rejects(carveSevenZip(source, target, pin(payload), pin(wrapper)), { code: 'EEXIST' });
  assert.deepEqual(await readFile(source), wrapper);
  assert.equal(await readFile(dest, 'utf8'), 'existing input');
});

test('exclusive writes and setup assembly clean only their own partial files', async t => {
  const root = await disposable(t), out = path.join(root, 'setup.exe');
  const stub = path.join(root, 'stub.fixture'), archive = path.join(root, 'archive.fixture');
  await writeFile(stub, 'stub');
  await assert.rejects(writeNewFile(out, async f => { await f.writeFile('part'); throw new Error('interrupted'); }), /interrupted/);
  await assert.rejects(writeSetup(stub, archive, out, 3), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), ['stub.fixture']);
  await writeFile(archive, 'zip');
  await assert.rejects(writeSetup(stub, archive, out, 4), /Incomplete/);
  await writeSetup(stub, archive, out, 3);
  const data = await readFile(out);
  assert.equal(data.subarray(0, -32).toString(), 'stubzip');
  assert.equal(data.readBigUInt64LE(data.length - 32), 4n);
  assert.equal(data.readBigUInt64LE(data.length - 24), 3n);
  assert.equal(data.subarray(-16).toString(), 'GROKBOT-SETUP-V1');
  await assert.rejects(writeSetup(stub, archive, out, 3), { code: 'EEXIST' });
  assert.deepEqual(await readFile(out), data);
});

test('late publication failure preserves a populated destination and undoes only completed files', async t => {
  const root = await disposable(t), stage = path.join(root, 'stage'), app = path.join(root, 'app');
  await mkdir(stage); await mkdir(app); await writeFile(path.join(app, 'personal'), 'keep');
  const build = path.join(stage, 'portable'), zip = path.join(root, 'out.zip'), report = path.join(root, 'report');
  await mkdir(build); await writeFile(path.join(build, 'app'), 'new');
  const files = [zip, report].map(destination => ({ destination, source: path.join(stage, path.basename(destination)), sha256: createHash('sha256').update('artifact').digest('hex') }));
  for (const { source } of files) await writeFile(source, 'artifact');
  await writeFile(report, 'preexisting');
  await assert.rejects(publishBuild(build, app, files), { code: 'EEXIST' });
  assert.equal(await readFile(report, 'utf8'), 'preexisting');
  await assert.rejects(readFile(zip), { code: 'ENOENT' });
  await rm(report);
  await assert.rejects(publishBuild(build, app, files));
  assert.deepEqual((await readdir(root)).sort(), ['app', 'stage']);
  assert.equal(await readFile(path.join(app, 'personal'), 'utf8'), 'keep');
  const fresh = path.join(root, 'fresh');
  await publishBuild(build, fresh, files);
  assert.equal(await readFile(path.join(fresh, 'app'), 'utf8'), 'new');
  assert.equal(await readFile(zip, 'utf8'), 'artifact');
});

test('failed extraction does not alter input, preexisting scratch files or leave partial output', async t => {
  const root = await disposable(t), source = path.join(root, 'broken.7z');
  const scratch = path.join(root, 'scratch'), keep = path.join(scratch, 'original');
  await mkdir(keep, { recursive: true }); await writeFile(path.join(keep, 'note'), 'personal');
  const bytes = Buffer.from('not an archive'); await writeFile(source, bytes);
  const payload = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await assert.rejects(unpackOriginal(source, scratch, { payload }), /无法解压/);
  assert.deepEqual(await readdir(scratch), ['original']);
  assert.equal(await readFile(path.join(keep, 'note'), 'utf8'), 'personal');
  assert.deepEqual(await readFile(source), bytes);
});

test('output guards include junctions, absent descendants and each final artifact', async t => {
  const root = await disposable(t), source = path.join(root, 'input'), alias = path.join(root, 'alias');
  await mkdir(source); await writeFile(path.join(source, 'keep'), 'unchanged');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const dest = path.join(root, 'out');
  for (const output of [source, path.join(source, 'new'), path.join(alias, 'new', 'nested')])
    await assert.rejects(checkOutputLocation(source, output, []), /source/);
  await assert.rejects(checkOutputLocation(source, root, [alias]), /source/);
  await assert.rejects(checkOutputLocation(path.join(source, 'keep'), root, [source]), /source/);
  await checkOutputLocation(source, dest, [path.join(dest, 'app')]);
  assert.deepEqual(await readdir(source), ['keep']);
});

test('the Windows CLI leaves rejected explicit inputs and output directories untouched', { skip: process.platform !== 'win32' }, async t => {
  const root = await disposable(t), source = path.join(root, 'input'), resources = path.join(source, 'resources');
  await mkdir(resources, { recursive: true });
  const exe = path.join(source, 'Grok Bot.exe'), asar = path.join(resources, 'app.asar');
  await writeFile(exe, 'synthetic exe'); await writeFile(asar, 'synthetic archive');
  const cli = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
  for (const input of [source, exe]) {
    for (const extra of [[], ['--verify-only']]) {
      await assert.rejects(promisify(execFile)(process.execPath, [cli, '--source', input, '--output', path.join(source, 'output'), ...extra], { windowsHide: true }), error => error.code === 1 && /摘要不匹配/.test(error.stderr));
    }
  }
  assert.deepEqual((await readdir(source)).sort(), ['Grok Bot.exe', 'resources']);
  assert.deepEqual(await readdir(resources), ['app.asar']);
  assert.equal(await readFile(exe, 'utf8'), 'synthetic exe');
  assert.equal(await readFile(asar, 'utf8'), 'synthetic archive');
});
