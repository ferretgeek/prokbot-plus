import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { BRIDGE_TAGS, stageAndroidArchive, verifyStagedRenderer } from '../patchers/patch.mjs';

const asar = createRequire(new URL('../../mac/patchers/desktop/package.json', import.meta.url))('@electron/asar');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = 'frame-src sand-html-preview: sand-canvas: sand-mcp-app:;';
const html = `<meta http-equiv="Content-Security-Policy" content="${frame}"><script type="module" crossorigin src="./assets/index-fixture.js"></script>`;
const index = 'dist/renderer/index.html', renderer = 'assets/index-fixture.js';

async function fixture(t, { indexHtml = html, rendererText = 'entry()', patchPin = rendererText, preloadPin = 'fixture-preload',
  recipeHash, recipeTarget = index, newFile = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'grokbot-android-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'source'), archive = path.join(root, 'fixture.asar'), recipes = path.join(root, 'recipes');
  const original = 'unused original entry point';
  const files = { [index]: original, [`dist/renderer/${renderer}`]: rendererText, 'dist/renderer/assets/unused.bin': 'unrelated asset',
    'dist/electron-preload/preload.cjs': 'fixture-preload', 'dist/electron-preload/preload-vnc.cjs': 'fixture-vnc' };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(input, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await asar.createPackage(input, archive);
  const bytes = Buffer.from(indexHtml);
  const recipe = gzipSync(JSON.stringify({ schema: 'grokbot-bytepatch/v1', sourceBytes: Buffer.byteLength(original), sourceSha256: sha(original),
    targetBytes: bytes.length, targetSha256: recipeHash ?? sha(bytes), ops: [['add', bytes.toString('base64')]] }));
  await mkdir(recipes);
  await writeFile(path.join(recipes, 'one.gz'), recipe);
  await writeFile(path.join(recipes, 'manifest.json'), JSON.stringify({ schema: 'grokbot-desktop-recipes/v1', files: [
    { source: index, path: recipeTarget, newFile, recipe: 'one.gz', sha256: sha(recipe) }] }));
  const build = { rendererIndexSha256: sha(bytes), preloadSha256: sha(preloadPin), vncPreloadSha256: sha('fixture-vnc') };
  const patches = [{ file: renderer, sha256: sha(patchPin), edits: [['entry()', 'checked()']] }];
  return { input, archive, recipes, build, patches, scratch: path.join(root, 'scratch') };
}

const stage = (f, verifyOnly = true) => stageAndroidArchive(asar, f.archive, f.scratch, f.recipes, verifyOnly, f.patches);
const replay = f => verifyStagedRenderer(path.join(f.scratch, 'dist'), f.build, f.patches);

test('verification replays Windows and Android changes on selected ASAR members only, without touching the input', async t => {
  const f = await fixture(t);
  assert.equal(await stage(f), 1);
  assert.deepEqual(await replay(f), { preload: 'fixture-preload', vncPreload: 'fixture-vnc' });
  const checked = await readFile(path.join(f.scratch, index), 'utf8');
  assert.ok(checked.includes(BRIDGE_TAGS));
  assert.ok(checked.includes('sand-mcp-app: http://127.0.0.1:*;'));
  assert.equal(await readFile(path.join(f.scratch, 'dist/renderer', renderer), 'utf8'), 'checked()');
  assert.equal(asar.extractFile(f.archive, path.normalize(index)).toString(), 'unused original entry point');
  assert.equal(await readFile(path.join(f.input, 'dist/renderer', renderer), 'utf8'), 'entry()');
  const unused = 'dist/renderer/assets/unused.bin';
  await assert.rejects(readFile(path.join(f.scratch, unused)), { code: 'ENOENT' });
  const forBuild = { ...f, scratch: f.scratch + '-build' };
  await stage(forBuild, false);
  await replay(forBuild);
  assert.equal(await readFile(path.join(forBuild.scratch, unused), 'utf8'), 'unrelated asset');
  assert.equal(await readFile(path.join(forBuild.scratch, index), 'utf8'), checked);
});

test('verification does not accept a bad Windows recipe output or skip an existing new-file destination', async t => {
  await assert.rejects(stage(await fixture(t, { recipeHash: sha('wrong output') })), /Patch output fingerprint mismatch/);
  await assert.rejects(stage(await fixture(t, { recipeTarget: 'dist/renderer/assets/unused.bin', newFile: true })), /destination already exists/);
});

test('invalid Android entry, preload or pinned renderer edits abort the shared scratch check', async t => {
  for (const [variant, reason] of [[{ indexHtml: html.replace(frame, frame + frame) }, /界面入口/],
    [{ indexHtml: html + html.slice(html.indexOf('<script')) }, /界面入口/],
    [{ preloadPin: 'wrong preload' }, /preload\.cjs/], [{ patchPin: 'wrong source' }, /界面文件/],
    [{ rendererText: 'entry() + entry()' }, /锚点不唯一/]]) {
    const f = await fixture(t, variant);
    await stage(f);
    await assert.rejects(replay(f), reason);
  }
});
