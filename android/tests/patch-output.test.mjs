import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBuildOutput, writeBuildOutput } from '../patchers/output.mjs';

const script = fileURLToPath(new URL('../patchers/patch.mjs', import.meta.url));
const run = (...args) => promisify(execFile)(process.execPath, [script, ...args], { windowsHide: true });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'grokbot-patch-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('an unsupported source leaves existing output and the signing key location untouched', async t => {
  const root = await fixture(t), input = path.join(root, 'fixture.exe'), output = path.join(root, 'output');
  await mkdir(output);
  await writeFile(path.join(output, 'keep'), 'original');
  await writeFile(input, 'not an installer');
  await assert.rejects(run('--source', input, '--output', output, '--signing-key', path.join(root, 'key'), '--force'),
    error => error.code === 1 && /摘要不匹配/.test(error.stderr));
  assert.deepEqual((await readdir(root)).sort(), ['fixture.exe', 'output']);
  assert.deepEqual(await readdir(output), ['keep']);
  assert.equal(await readFile(path.join(output, 'keep'), 'utf8'), 'original');
});

test('verify-only rejects an unreviewed custom shell before acquiring the source or accessing build destinations', async t => {
  const root = await fixture(t), shell = path.join(root, 'unreviewed.apk');
  await writeFile(shell, 'unreviewed fixture');
  await assert.rejects(run('--verify-only', '--shell', shell, '--source', path.join(root, 'absent.exe'),
    '--output', path.join(root, 'output'), '--signing-key', path.join(root, 'unused-key')),
  error => error.code === 1 && /外壳 APK 摘要不匹配/.test(error.stderr) && !error.stdout.includes('"verified"'));
  assert.deepEqual(await readdir(root), ['unreviewed.apk']);
});

// The offline suite needs no vendor binary. Run this integration case with an explicitly supplied pinned installer.
const source = process.env.PROKBOT_ANDROID_TEST_SOURCE;
test('verify-only writes nothing; a blocked manifest destination cannot replace the prior APK under --force',
  { skip: !source && 'set PROKBOT_ANDROID_TEST_SOURCE to a pinned local installer' }, async t => {
    const root = await fixture(t), output = path.join(root, 'output'), key = path.join(root, 'key.json');
    const args = ['--source', source, '--output', output, '--signing-key', key];
    const { stdout } = await run(...args, '--verify-only');
    const { verified, shell, rendererVersion, checks } = JSON.parse(stdout);
    const android = JSON.parse(await readFile(new URL('../patchers/supported.json', import.meta.url), 'utf8'));
    const windows = JSON.parse(await readFile(new URL('../../windows/patchers/desktop/recipes/manifest.json', import.meta.url), 'utf8'));
    assert.equal(verified, true);
    assert.deepEqual(shell, { versionName: android.shell.versionName, versionCode: android.shell.versionCode });
    assert.equal(rendererVersion, android.desktopVersion);
    assert.equal(checks.windowsRecipes, windows.files.length);
    assert.ok(checks.androidRendererPatches > 0);
    assert.deepEqual(await readdir(root), []);
    const base = `GrokBotLocal-${shell.versionName}-android`, apk = path.join(output, `${base}.apk`);
    const manifest = path.join(output, `${base}.patch.json`);
    await mkdir(manifest, { recursive: true });
    await writeFile(apk, 'previous build');
    await writeFile(path.join(manifest, 'keep'), 'unrelated file');
    await assert.rejects(run(...args, '--force'), { code: 1 });
    assert.equal((await readFile(apk)).equals(Buffer.from('previous build')), true, 'previous APK was overwritten');
    assert.deepEqual(await readdir(root), ['output']);
    assert.deepEqual((await readdir(output)).sort(), [`${base}.apk`, `${base}.patch.json`]);
    assert.equal(await readFile(path.join(manifest, 'keep'), 'utf8'), 'unrelated file');
  });

test('a late publication failure rolls back new files and restores only replaced regular files', async t => {
  const root = await fixture(t), apk = path.join(root, 'fixture.apk'), report = path.join(root, 'report.json');
  const entries = [{ target: apk, bytes: 'new APK' }, { target: report, bytes: 'new report' }];
  await mkdir(report);
  await writeFile(path.join(report, 'keep'), 'unrelated');
  await assert.rejects(writeBuildOutput(root, entries, false), /输出已存在/);
  assert.deepEqual(await readdir(root), ['report.json']);
  await writeFile(apk, 'previous APK');
  await assert.rejects(writeBuildOutput(root, entries, true), /不是普通文件/);
  assert.equal(await readFile(apk, 'utf8'), 'previous APK');
  assert.equal(await readFile(path.join(report, 'keep'), 'utf8'), 'unrelated');
  assert.deepEqual((await readdir(root)).sort(), ['fixture.apk', 'report.json']);
  const manifest = path.join(root, 'fixture.json');
  await writeFile(manifest, 'previous report');
  await writeBuildOutput(root, [entries[0], { ...entries[1], target: manifest }], true);
  assert.equal(await readFile(apk, 'utf8'), 'new APK');
  assert.equal(await readFile(manifest, 'utf8'), 'new report');
  assert.deepEqual((await readdir(root)).sort(), ['fixture.apk', 'fixture.json', 'report.json']);
});

test('a signing key or original install directory cannot be used as build output', async t => {
  const root = await fixture(t), source = path.join(root, 'original'), shell = path.join(root, 'shell.apk');
  const key = path.join(root, 'signing.json'), targets = [path.join(root, 'new', 'output.apk')];
  await mkdir(source);
  await writeFile(shell, 'shell');
  await checkBuildOutput({ source, shell, key, targets, force: true });
  for (const target of [key, shell, path.join(source, 'new', 'output.apk')])
    await assert.rejects(checkBuildOutput({ source, shell, key, targets: [target], force: true }), /重叠/);
  assert.deepEqual((await readdir(root)).sort(), ['original', 'shell.apk']);
});
