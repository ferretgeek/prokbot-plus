// Offline maintenance check: report what the build tools actually pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = file => readFile(join(root, file));
const json = async file => JSON.parse(await bytes(file));
const sha = async file => createHash('sha256').update(await bytes(file)).digest('hex');
async function checkRecipes(dir, records, key, sources) {
  assert.ok(records.length, `${dir}: empty recipe manifest`);
  for (const item of records) {
    assert.match(item[key], /^[\w.-]+\.gz$/);
    const buffer = await bytes(`${dir}/${item[key]}`);
    assert.equal(buffer.readUInt16BE(0), 0x1f8b, `${dir}/${item[key]} is not gzip`);
    if (sources) {
      assert.match(sources[item.source] ?? '', /^[0-9a-f]{64}$/);
      assert.equal(JSON.parse(gunzipSync(buffer)).sourceSha256, sources[item.source], `stale source pin in ${item[key]}`);
    }
  }
}
const host = await json('host/recipes/host/manifest.json');
await checkRecipes('host/recipes/host', host.files, 'patch', host.sourceSha256);
assert.match(host.archive.sha256, /^[0-9a-f]{64}$/);
for (const key of ['manifestDigest', 'configDigest']) assert.match(host.box[key], /^sha256:[0-9a-f]{64}$/);
for (const file of ['compose.yaml', 'compose.execution.yaml']) {
  const compose = (await bytes(`host/release/${file}`)).toString();
  assert.ok(compose.includes('${GROKBOT_BOX_IMAGE:-' + host.box.localTag + '}'), `stale desktop tag in ${file}`);
  assert.ok(compose.split('\n  box:\n')[1]?.includes(`platform: ${host.box.platform}`), `wrong desktop platform in ${file}`);
}
const versions = { host: host.archive.version, desktop: `${host.box.localTag} (${host.box.platform})` };
for (const name of ['mac', 'windows']) {
  const dir = `${name}/patchers/desktop`;
  const original = await json(`${dir}/supported.json`);
  assert.match(original.archive.sha256, /^[0-9a-f]{64}$/);
  await checkRecipes(`${dir}/recipes`, (await json(`${dir}/recipes/manifest.json`)).files, 'recipe');
  versions[name] = original.version;
}
const android = await json('android/patchers/supported.json');
assert.equal(android.desktopVersion, versions.windows, 'Android must match the Windows renderer input');
assert.equal(await sha(android.shell.path), android.shell.sha256, 'Android shell digest mismatch');
const ios = await json('ios/recipes/ios/manifest.json');
await checkRecipes('ios/recipes/ios', ios.resources, 'patch');
assert.equal(await sha('ios/bin/GrokBotLocal.dylib'), ios.dylibSha256, 'iOS injected library digest mismatch');
console.log(JSON.stringify({ ...versions, androidRenderer: android.desktopVersion, ios: `${ios.version} (${ios.build})` }, null, 2));
