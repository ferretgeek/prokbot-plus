// Offline maintenance check: report what the build tools actually pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { inspectRecipe } from './recipe-pin.mjs';
import { readZip } from '../android/patchers/apk.mjs';
import { verifyShellVersion } from '../android/patchers/shell-version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = file => readFile(join(root, file));
const json = async file => JSON.parse(await bytes(file));
const sha = async file => createHash('sha256').update(await bytes(file)).digest('hex');
async function checkRecipes(dir, records, key, sources) {
  assert.ok(records.length, `${dir}: empty recipe manifest`);
  const pins = new Map();
  for (const item of records) {
    assert.match(item[key], /^[\w.-]+\.gz$/);
    const buffer = await bytes(`${dir}/${item[key]}`);
    const target = item.path ?? item.target;
    assert.ok(typeof target === 'string' && !pins.has(target), `duplicate or missing recipe target: ${target}`);
    const sourcePin = typeof sources === 'string' ? sources : sources?.[item.source];
    if (sources) assert.match(sourcePin ?? '', /^[0-9a-f]{64}$/);
    pins.set(target, inspectRecipe(buffer, `${dir}/${item[key]}`, item, sourcePin));
  }
  return pins;
}
const host = await json('host/recipes/host/manifest.json');
await checkRecipes('host/recipes/host', host.files, 'patch', host.sourceSha256);
assert.match(host.archive.sha256, /^[0-9a-f]{64}$/);
for (const key of ['manifestDigest', 'configDigest']) assert.match(host.box[key], /^sha256:[0-9a-f]{64}$/);
const dockerfile = (await bytes('host/release/Dockerfile.host')).toString().split(/\r?\n/);
const runtimeArgs = dockerfile.filter(line => /^ARG RUNTIME_IMAGE(?:=|$)/.test(line));
assert.equal(runtimeArgs.length, 1, 'missing or ambiguous runtime image argument');
assert.ok(runtimeArgs[0] === `ARG RUNTIME_IMAGE=${host.box.localTag}` || runtimeArgs[0] === 'ARG RUNTIME_IMAGE',
  'stale default desktop base in Dockerfile.host');
assert.ok(dockerfile.includes('FROM ${RUNTIME_IMAGE}'), 'Dockerfile does not use the selected runtime');
const builder = (await bytes('host/release/build-docker.py')).toString();
assert.ok(builder.includes("'--build-arg', f'RUNTIME_IMAGE={runtime_image}'") && builder.includes('choose_runtime(platform, args.host_only)'),
  'Host builder must explicitly pass the runtime chosen for its platform and mode');
for (const file of ['compose.yaml', 'compose.execution.yaml']) {
  const compose = (await bytes(`host/release/${file}`)).toString();
  assert.ok(compose.includes('${GROKBOT_BOX_IMAGE:-' + host.box.localTag + '}'), `stale desktop tag in ${file}`);
  assert.ok(compose.split('\n  box:\n')[1]?.includes(`platform: ${host.box.platform}`), `wrong desktop platform in ${file}`);
}
const versions = { host: host.archive.version, desktop: `${host.box.localTag} (${host.box.platform})` };
const desktopPins = {};
for (const name of ['mac', 'windows']) {
  const dir = `${name}/patchers/desktop`;
  const original = await json(`${dir}/supported.json`);
  assert.match(original.archive.sha256, /^[0-9a-f]{64}$/);
  const list = (await json(`${dir}/recipes/manifest.json`)).files;
  const pins = desktopPins[name] = await checkRecipes(`${dir}/recipes`, list, 'recipe');
  assert.equal(pins.get('dist/electron-preload/preload.cjs')?.input, original.preloadSha256, `${name}: stale preload source`);
  const policy = await json(`${dir}/notification-policy.json`);
  const source = list.find(item => item.source === policy.source);
  assert.ok(source, `${name}: missing notification policy source`);
  assert.equal(pins.get(source.path).input, policy.sourceSha256, `${name}: stale notification policy source`);
  versions[name] = original.version;
}
const android = await json('android/patchers/supported.json');
assert.equal(android.desktopVersion, versions.windows, 'Android must match the Windows renderer input');
assert.equal(desktopPins.windows.get('dist/renderer/index.html')?.output, android.rendererIndexSha256, 'stale Android renderer index');
assert.equal(desktopPins.windows.get('dist/electron-preload/preload.cjs')?.output, android.preloadSha256, 'stale Android preload');
assert.equal(await sha(android.shell.path), android.shell.sha256, 'Android shell digest mismatch');
const shell = verifyShellVersion(readZip(await bytes(android.shell.path)).entries, android.shell);
const ios = await json('ios/recipes/ios/manifest.json');
await checkRecipes('ios/recipes/ios', ios.resources, 'patch', ios.hbcSha256);
assert.equal(await sha('ios/bin/GrokBotLocal.dylib'), ios.dylibSha256, 'iOS injected library digest mismatch');
console.log(JSON.stringify({ ...versions, androidShell: `${shell.versionName} (${shell.versionCode})`, androidRenderer: android.desktopVersion, ios: `${ios.version} (${ios.build})` }, null, 2));
