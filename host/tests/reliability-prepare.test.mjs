import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const host = fileURLToPath(new URL('..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The generated seed is not in the repository, but the manifest recipe carries
// the runtime pins as added bytes, so a change to a pinned module fails here
// instead of at Host startup.
test('runtime modules pinned by the reliability manifest recipe match host/runtime', async () => {
  const recipe = JSON.parse(gunzipSync(await readFile(join(host, 'recipes/host/release-reliability__manifest.json.gbp.gz'))));
  const added = Buffer.concat(recipe.ops.filter(op => op[0] === 'add').map(op => Buffer.from(op[1], 'base64'))).toString();
  const pins = new Map([...added.matchAll(/"name": "runtime\/([^"]+)",\s*"sha256": "([0-9a-f]{64})"/g)].map(m => [m[1], m[2]]));
  assert.ok(pins.size > 0, 'no runtime pins found in the manifest recipe');
  const hint = 'regenerate host/recipes/host/release-reliability__manifest.json.gbp.gz (docs/ARCHITECTURE.md)';
  for (const [name, expected] of pins) {
    const bytes = await readFile(join(host, 'runtime', name));
    assert.equal(sha256(bytes), expected, `host/runtime/${name} changed: ${hint}`);
    for (const match of bytes.toString().matchAll(/["'](\.{1,2}\/[^"'\n]+\.mjs)["']/g)) {
      const imported = posix.join(posix.dirname(name), match[1]);
      assert.ok(pins.has(imported), `host/runtime/${name} now imports ${imported}: ${hint}`);
    }
  }
});

test('startup refuses edited runtime dependencies and an edited prepared cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reliability-prepare-'));
  try {
    const runtime = join(root, 'runtime'), seed = join(root, 'seed/release-reliability'), state = join(root, 'state');
    for (const directory of [join(runtime, 'reliability'), join(runtime, 'sub'), seed, state]) await mkdir(directory, { recursive: true });
    for (const name of ['prepare.mjs', 'seed-manifest.mjs'])
      await copyFile(join(host, 'runtime/reliability', name), join(runtime, 'reliability', name));
    await writeFile(join(runtime, 'dep.mjs'), "export { leaf } from './sub/leaf.mjs';\n");
    await writeFile(join(runtime, 'sub/leaf.mjs'), 'export const leaf = 1;\n');
    await writeFile(join(runtime, 'unused.mjs'), 'export const unused = 1;\n');
    await writeFile(join(seed, 'host-library-reliable.cjs'), 'module.exports = {};\n');
    await writeFile(join(seed, 'module.mjs'), 'import { leaf } from "file:///opt/grokbot/runtime/dep.mjs";\nexport default leaf;\n');
    await writeFile(join(seed, 'data.json'), '{}\n');
    const { writeSeedManifest } = await import(pathToFileURL(join(runtime, 'reliability/seed-manifest.mjs')).href);
    const manifest = await writeSeedManifest(seed, runtime, { name: 'fixture' });
    assert.deepEqual(manifest.runtimeFiles.map(file => file.name), ['runtime/dep.mjs', 'runtime/sub/leaf.mjs']);
    assert.equal(manifest.status.digest, manifest.digest);

    const { prepareHostReliability } = await import(pathToFileURL(join(runtime, 'reliability/prepare.mjs')).href);
    const prepared = await prepareHostReliability(state);
    assert.equal(prepared.directory, join(state, 'reliable-core', manifest.digest.slice(0, 20)));
    assert.equal(prepared.libraryPath, join(state, 'host-library-reliable.cjs'));
    assert.equal(await readFile(join(prepared.directory, 'module.mjs'), 'utf8'), await readFile(join(seed, 'module.mjs'), 'utf8'));
    await prepareHostReliability(state);

    const cached = join(prepared.directory, 'data.json');
    await appendFile(cached, ' ');
    await assert.rejects(prepareHostReliability(state), /Prepared runtime cache edited: data\.json/);
    await writeFile(cached, '{}\n');

    await appendFile(join(runtime, 'sub/leaf.mjs'), '// edited\n');
    await assert.rejects(prepareHostReliability(state), /dependency integrity failure: runtime\/sub\/leaf\.mjs/);
    await writeFile(join(runtime, 'sub/leaf.mjs'), 'export const leaf = 1;\n');

    await writeFile(join(seed, 'manifest.json'), JSON.stringify({ ...manifest, digest: '0'.repeat(64) }));
    await assert.rejects(prepareHostReliability(state), /identity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
