import test from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mac = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(path.join(mac, file), 'utf8'));
const builds = [
  { arch: 'arm64', inputs: 'patchers/desktop', tailcat: 'dist/network/grokbot-tailcat', cpu: 0x0100000c, feed: 'darwin-arm64' },
  { arch: 'x64', inputs: 'patchers/desktop/x64', tailcat: 'dist/network/x64/grokbot-tailcat', cpu: 0x01000007, feed: 'darwin-x64' },
];

async function machHeader(file) {
  const handle = await open(path.join(mac, file), 'r');
  try { const bytes = Buffer.alloc(8); await handle.read(bytes, 0, 8, 0); return bytes; } finally { await handle.close(); }
}

test('each Mac build has its own pinned original, recipes and Tailcat for its CPU', async () => {
  for (const build of builds) {
    const supported = await json(`${build.inputs}/supported.json`);
    assert.equal(supported.architecture, build.arch);
    assert.ok(supported.archive.url.includes(`/${build.feed}/${supported.version}/`), build.arch);
    for (const key of ['asarSha256', 'frameworkSha256', 'preloadSha256']) assert.match(supported[key], /^[0-9a-f]{64}$/);
    const manifest = await json(`${build.inputs}/recipes/manifest.json`);
    for (const entry of manifest.files)
      assert.equal(sha(await readFile(path.join(mac, build.inputs, 'recipes', entry.recipe))), entry.sha256, entry.path);
    await readFile(path.join(mac, build.inputs, 'notification-policy.json'));
    const header = await machHeader(build.tailcat);
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, `${build.tailcat} is not a 64-bit Mach-O`);
    assert.equal(header.readUInt32LE(4), build.cpu, `${build.tailcat} is built for another CPU`);
  }
});

test('the Intel recipes add the same code as the Apple silicon recipes', async () => {
  const [arm, x64] = await Promise.all(builds.map(build => json(`${build.inputs}/recipes/manifest.json`)));
  assert.equal(x64.files.length, arm.files.length);
  // Only the content hashes in renderer asset names differ between the two builds.
  // Two chunks sharing a prefix (e.g. chunk-view-*) can sort in different hash order across builds.
  const mask = text => text.replace(/-[\w-]{8}(\.(?:js|css|svg|png|wav|mp3|webp|woff2?|json|wasm))/g, '-HASHHASH$1');
  const summarize = async (inputs, manifest) => (await Promise.all(manifest.files.map(async entry => {
    const added = JSON.parse(gunzipSync(await readFile(path.join(mac, inputs, 'recipes', entry.recipe))))
      .ops.filter(op => op[0] === 'add').map(op => mask(Buffer.from(op[1], 'base64').toString('utf8')));
    return { path: mask(entry.path), added };
  }))).sort((a, b) => a.path.localeCompare(b.path) || JSON.stringify(a.added).localeCompare(JSON.stringify(b.added)));
  assert.deepEqual(await summarize(builds[1].inputs, x64), await summarize(builds[0].inputs, arm));
});

test('arm64 Mac builds pass --pagesize 16384 when signing binaries and the app bundle', async () => {
  const patcher = await readFile(path.join(mac, 'patchers/desktop/patch.mjs'), 'utf8');
  assert.match(patcher, /const signPageSize = arch === 'arm64' \? \['--pagesize', '16384'\] : \[\];/);
  const codesignCalls = patcher.match(/run\('codesign',[^\n]+\.\.\.signPageSize/g) ?? [];
  assert.equal(codesignCalls.length, 2);
});
