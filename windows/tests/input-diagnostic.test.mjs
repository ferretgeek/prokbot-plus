import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withInstallerDiagnostic } from '../patchers/desktop/input-diagnostic.mjs';
import { selectWindowsRelease, windowsInputs, windowsReleaseFor, windowsReleases } from '../patchers/desktop/inputs.mjs';

const repo = new URL('../../', import.meta.url);
const pin = data => ({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
const MISMATCH = '官方安装包摘要不匹配。';

async function disposable(t) {
  const base = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'grokbot-input-diagnostic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Fixture pins: 2.0.0 is recommended (beside the patcher), 1.0.0 and 1.5.0 are older releases
// in directories named after their versions.
async function fixtureReleases(root) {
  const bytes = { '2.0.0': Buffer.from('recommended installer'), '1.5.0': Buffer.from('middle installer!!'), '1.0.0': Buffer.from('older installer') };
  const asar = { '2.0.0': Buffer.from('asar 2'), '1.5.0': Buffer.from('asar 15'), '1.0.0': Buffer.from('asar 1') };
  const release = version => ({ version, architecture: 'x64', archive: pin(bytes[version]),
    payload: pin(Buffer.from(`payload ${version}`)), asarSha256: pin(asar[version]).sha256 });
  await fs.writeFile(path.join(root, 'supported.json'), JSON.stringify(release('2.0.0')));
  for (const version of ['1.0.0', '1.5.0']) {
    await fs.mkdir(path.join(root, version));
    await fs.writeFile(path.join(root, version, 'supported.json'), JSON.stringify(release(version)));
  }
  await fs.mkdir(path.join(root, 'recipes')); // Not a release.
  return { bytes, asar };
}

test('the recommended release comes first, then older releases newest first', async t => {
  const root = await disposable(t);
  await fixtureReleases(root);
  const releases = await windowsReleases(root);
  assert.deepEqual(releases.map(({ supported }) => supported.version), ['2.0.0', '1.5.0', '1.0.0']);
  assert.deepEqual(releases.map(({ directory }) => path.relative(root, directory)), ['', '1.5.0', '1.0.0']);
  await assert.rejects(windowsInputs('9.9.9', root), /No Windows 9\.9\.9 inputs/);
  await assert.rejects(windowsInputs('../2.0.0', root), /Invalid Windows version/);
  await fs.writeFile(path.join(root, '1.0.0', 'supported.json'), JSON.stringify({ version: '1.5.0' }));
  await assert.rejects(windowsReleases(root), /are for 1\.5\.0, not 1\.0\.0/);
});

test('an explicit installer, payload or install directory selects its release only by size and SHA-256', async t => {
  const root = await disposable(t), { bytes, asar } = await fixtureReleases(root);
  const releases = await windowsReleases(root);
  const versionOf = async source => (await windowsReleaseFor(source, releases)).supported.version;
  const file = async (name, data) => { const filename = path.join(root, name); await fs.writeFile(filename, data); return filename; };

  assert.equal(await versionOf(undefined), '2.0.0');
  assert.equal(await versionOf(await file('older.exe', bytes['1.0.0'])), '1.0.0');
  assert.equal(await versionOf(await file('renamed-setup.bin', bytes['1.5.0'])), '1.5.0');
  assert.equal(await versionOf(await file('app-64.7z', Buffer.from('payload 1.0.0'))), '1.0.0');
  // Same size as the 1.0.0 installer but other bytes: the recommended release's verification rejects it.
  const altered = Buffer.from(bytes['1.0.0']); altered[0] ^= 1;
  assert.equal(await versionOf(await file('altered.exe', altered)), '2.0.0');
  assert.equal(await versionOf(await file('unknown.exe', Buffer.from('x'))), '2.0.0');

  const install = path.join(root, 'installed');
  await fs.mkdir(path.join(install, 'resources'), { recursive: true });
  assert.equal(await versionOf(install), '2.0.0'); // No app.asar.
  await fs.writeFile(path.join(install, 'resources/app.asar'), asar['1.5.0']);
  assert.equal(await versionOf(install), '1.5.0');
  await assert.rejects(windowsReleaseFor(undefined, []), /No Windows releases/);
});

test('this repository builds Windows 1.3.0 (recommended) and 1.2.3/1.1.0/0.71.2 (fallback) with distinct pins', async () => {
  const releases = await windowsReleases();
  assert.deepEqual(releases.map(({ supported }) => supported.version), ['1.3.0', '1.2.3', '1.1.0', '0.71.2']);
  const digests = releases.flatMap(({ supported }) => [supported.archive.sha256, supported.payload.sha256, supported.asarSha256]);
  assert.equal(new Set(digests).size, digests.length);
  for (const { directory, supported } of releases) {
    assert.equal(supported.architecture, 'x64');
    assert.ok(supported.archive.url.endsWith(`/win32-x64/${supported.version}/Grok_Bot_${supported.version}_Setup.exe`), supported.version);
    for (const name of ['recipes/manifest.json', 'notification-policy.json']) await fs.access(path.join(directory, name));
  }
  assert.equal((await selectWindowsRelease({ version: '1.2.3' })).supported.version, '1.2.3');
  assert.equal((await selectWindowsRelease({ version: '1.1.0' })).supported.version, '1.1.0');
  assert.equal((await selectWindowsRelease({ version: '0.71.2' })).supported.version, '0.71.2');
  assert.equal((await selectWindowsRelease({})).supported.version, '1.3.0');
  await assert.rejects(selectWindowsRelease({ version: '0.70.0' }), /不支持 Grok Bot 0\.70\.0。可用版本：1\.3\.0、1\.2\.3、1\.1\.0、0\.71\.2。/);
  await assert.rejects(selectWindowsRelease({ version: '1.3.0', accepted: ['1.1.0', '0.71.2'] }), /可用版本：1\.1\.0、0\.71\.2。/);
  await assert.rejects(fs.access(new URL('windows/patchers/desktop/known-unsupported.json', repo)), { code: 'ENOENT' });
});

test('an unknown explicit installer is explained in both languages without any file access', async t => {
  const supported = (await windowsReleases())[0].supported;
  const reads = [t.mock.method(fs, 'open'), t.mock.method(fs, 'stat'), t.mock.method(fs, 'readFile'), t.mock.method(nativeFs, 'createReadStream')];
  syncBuiltinESMExports();
  t.after(() => { for (const read of reads) read.mock.restore(); syncBuiltinESMExports(); });

  const cause = new Error(MISMATCH);
  await assert.rejects(withInstallerDiagnostic(Promise.reject(cause), 'C:\\Downloads\\Setup.EXE', supported, ['1.3.0', '1.2.3', '1.1.0', '0.71.2']), error => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /未进入配对/);
    assert.ok(error.message.includes('官方 Grok Bot 1.3.0（推荐）或 1.2.3、1.1.0、0.71.2 Windows x64 安装包'));
    assert.match(error.message, /The version and origin of this file are unverified\. Pairing did not run\./);
    assert.ok(error.message.includes('Grok Bot 1.3.0 (recommended) or 1.2.3, 1.1.0, 0.71.2 Windows x64 installer'));
    assert.ok(error.message.includes('Omit --source to fetch the exact supported Grok Bot 1.3.0 Windows x64 installer'));
    assert.match(error.message, /No need to uninstall your existing app/);
    return true;
  });
  await assert.rejects(withInstallerDiagnostic(Promise.reject(cause), 'Setup.exe', supported), error =>
    error.message.includes('1.3.0 (recommended) Windows x64') && !error.message.includes('0.71.2'));
  // Success, other errors, and sources that are not an installer pass through unchanged.
  assert.equal(await withInstallerDiagnostic(Promise.resolve('payload'), 'Setup.exe', supported), 'payload');
  for (const [source, error] of [[null, cause], ['app-64.7z', cause], ['C:\\install', cause], ['Setup.exe', new Error('EACCES')],
    ['Setup.exe', new Error('安装包中没有找到受支持的程序包。')]]) {
    await assert.rejects(withInstallerDiagnostic(Promise.reject(error), source, supported), thrown => thrown === error);
  }
  for (const read of reads) assert.equal(read.mock.callCount(), 0);
});

test('the Windows CLI explains an unknown installer and leaves the output untouched',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await disposable(t), output = path.join(root, 'output'), source = path.join(root, 'Grok_Bot_1.3.0_Setup.exe');
    const keep = 'GrokBotLocal-1.3.0-x64.patch.json';
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, keep), 'previous build');
    await fs.writeFile(source, Buffer.alloc(4096, 'x'));
    const patcher = fileURLToPath(new URL('windows/patchers/desktop/patch.mjs', repo));
    await assert.rejects(promisify(execFile)(process.execPath, [patcher, '--source', source, '--output', output],
      { cwd: root, windowsHide: true, timeout: 30000 }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /origin of this file are unverified\. Pairing did not run\./);
      assert.ok(error.stderr.includes('1.3.0 (recommended) or 1.2.3, 1.1.0, 0.71.2'));
      return true;
    });
    assert.deepEqual(await fs.readdir(output), [keep]);
    assert.equal(await fs.readFile(path.join(output, keep), 'utf8'), 'previous build');
  });
