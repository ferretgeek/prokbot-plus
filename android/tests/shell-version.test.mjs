import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createEntry, readZip } from '../patchers/apk.mjs';
import { readPinnedShell } from '../patchers/patch.mjs';
import { checkVersionAdvance, readShellManifest, verifyClientVersions, verifyShellVersion } from '../patchers/shell-version.mjs';

const repo = new URL('../../', import.meta.url);
const text = name => readFile(new URL(name, repo), 'utf8');
const build = JSON.parse(await text('android/patchers/supported.json'));
const { versionName, versionCode } = build.shell, apk = fileURLToPath(new URL(build.shell.path, repo));

test('Gradle and the independently pinned Windows renderer match the release metadata', async () => {
  const gradle = await text('android/shell/app/build.gradle.kts');
  assert.deepEqual([...gradle.matchAll(/^\s*versionName\s*=\s*"([^"]+)"\s*$/gm)].map(m => m[1]), [versionName]);
  assert.deepEqual([...gradle.matchAll(/^\s*versionCode\s*=\s*(\d+)\s*$/gm)].map(m => Number(m[1])), [versionCode]);
  assert.ok(Number.isSafeInteger(versionCode) && versionCode > 7102, 'must upgrade the original renderer-numbered Android shell');
  assert.equal(build.desktopVersion, JSON.parse(await text('windows/patchers/desktop/supported.json')).version);
});

test('the bundled APK must match both the reviewed digest and the compiled Android release version', async () => {
  const { manifest } = await readPinnedShell(apk, build.shell);
  assert.deepEqual(manifest, { packageName: 'dev.grokbot.local', versionName, versionCode });
});

test('both READMEs and CLI help identify the input, shell version/code and exact two output names', async () => {
  const help = execFileSync(process.execPath, [fileURLToPath(new URL('android/patchers/patch.mjs', repo)), '--help'], { encoding: 'utf8', windowsHide: true });
  for (const [label, content] of [['--help', help], ['README.md', await text('android/README.md')], ['README.en.md', await text('android/README.en.md')]]) {
    const outputs = [...content.matchAll(/GrokBotLocal-[\d.]+-android\.(?:apk|patch\.json)/g)].map(m => m[0]);
    assert.deepEqual([...new Set(outputs)].sort(), [`GrokBotLocal-${versionName}-android.apk`, `GrokBotLocal-${versionName}-android.patch.json`], label);
    assert.ok(content.includes(`Grok_Bot_${build.desktopVersion}_Setup.exe`), label);
    if (label === '--help') {
      assert.ok(content.includes(`${versionName}（versionCode ${versionCode}）`) && content.includes(`renderer ${build.desktopVersion}`), label);
    } else {
      assert.ok(content.includes('`versionName` **' + versionName + '**') && content.includes('`versionCode` **' + versionCode + '**'), label);
      for (const field of ['shell.versionName', 'shell.versionCode', 'rendererVersion']) assert.ok(content.includes('`' + field + '`'), label);
    }
  }
});

test('different bytes or a different manifest are rejected even at an explicitly supplied shell path', async () => {
  const bytes = await readFile(apk), entries = readZip(bytes).entries;
  const actual = readShellManifest(entries), sha256 = createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(readPinnedShell(apk, { ...actual, sha256: '0'.repeat(64) }), /SHA-256|摘要不匹配/);
  await assert.rejects(readPinnedShell(apk, { ...actual, sha256, versionCode: actual.versionCode + 1 }), /version mismatch/);
  assert.throws(() => verifyShellVersion(entries, { ...actual, versionName: actual.versionName + '.stale' }), /version mismatch/);
  const manifest = entries.find(e => e.name === 'AndroidManifest.xml');
  assert.throws(() => readShellManifest([]), /exactly one manifest/);
  assert.throws(() => readShellManifest([manifest, manifest]), /exactly one manifest/);
  assert.throws(() => readShellManifest([createEntry(manifest.name, '<manifest/>')]), /Invalid AndroidManifest/);
});

test('the final APK check reads the embedded build record and its compiled manifest independently', async () => {
  const entries = readZip(await readFile(apk)).entries, actual = readShellManifest(entries);
  const pin = { shell: actual, desktopVersion: 'fixture.renderer' };
  const shell = { versionName: actual.versionName, versionCode: actual.versionCode };
  const record = value => createEntry('assets/web/client/build.json', JSON.stringify(value));
  const valid = record({ shell, rendererVersion: pin.desktopVersion });
  assert.deepEqual(verifyClientVersions([...entries, valid], pin), actual);
  assert.throws(() => verifyClientVersions(entries, pin), /exactly one/);
  assert.throws(() => verifyClientVersions([...entries, valid, valid], pin), /exactly one/);
  for (const value of [{ version: actual.versionName }, { shell, rendererVersion: actual.versionName },
    { shell: { ...shell, versionCode: actual.versionCode + 1 }, rendererVersion: pin.desktopVersion }])
    assert.throws(() => verifyClientVersions([...entries, record(value)], pin), /record version mismatch/);
});

test('rebuilding the same shell is allowed but releasing a renamed shell requires a larger Android code', () => {
  const old = { versionName: '0.71.2', versionCode: 7102 };
  assert.doesNotThrow(() => checkVersionAdvance(old, { versionName, versionCode }));
  assert.doesNotThrow(() => checkVersionAdvance(build.shell, build.shell));
  assert.throws(() => checkVersionAdvance(build.shell, old), /versionCode must increase/);
  assert.throws(() => checkVersionAdvance(build.shell, { versionName: versionName + '.next', versionCode }), /versionCode must increase/);
});
