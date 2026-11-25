import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { applyByteRecipe } from '../../mac/patchers/desktop/release-recipes.mjs';
import { buildRecipe } from '../tools/desktop-recipes/build.mjs';
import { SPEC } from '../tools/desktop-recipes/spec.mjs';

const desktop = new URL('../patchers/desktop/', import.meta.url);
const extensions = new URL('../tools/desktop-recipes/extensions/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(new URL('recipes/manifest.json', desktop), 'utf8'));
const committed = await Promise.all(manifest.files.map(async entry => {
  const bytes = await readFile(new URL(`recipes/${entry.recipe}`, desktop));
  return { entry, bytes, recipe: JSON.parse(gunzipSync(bytes)) };
}));
const addedBytes = recipe => Buffer.concat(recipe.ops.filter(op => op[0] === 'add').map(op => Buffer.from(op[1], 'base64')));

test('the committed Windows recipes are the spec entries in path order', async () => {
  const sorted = [...SPEC].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(manifest.schema, 'grokbot-desktop-recipes/v1');
  assert.deepEqual(manifest.files.map(entry => [entry.path, entry.source]), sorted.map(entry => [entry.path, entry.source]));
  for (const [index, { entry, bytes, recipe }] of committed.entries()) {
    assert.equal(entry.recipe, `${String(index).padStart(3, '0')}.gbp.gz`);
    assert.equal(entry.newFile, entry.source !== entry.path, entry.path);
    assert.equal(sha(bytes), entry.sha256, entry.recipe);
    assert.equal(recipe.schema, 'grokbot-bytepatch/v1');
    assert.equal(recipe.targetBytes, entry.targetBytes, entry.recipe);
    assert.equal(addedBytes(recipe).length, entry.addedBytes, entry.recipe);
    if (entry.source === null) assert.equal(recipe.sourceSha256, sha(Buffer.alloc(0)));
  }
  const names = (await readdir(new URL('recipes/', desktop))).sort();
  assert.deepEqual(names, [...manifest.files.map(entry => entry.recipe), 'manifest.json'].sort());
});

test('every extension source is carried verbatim by a recipe', async () => {
  const names = await readdir(extensions);
  assert.ok(names.length > 0);
  const targets = [
    { label: 'windows', list: committed },
    ...await Promise.all([
      ['mac-arm64', new URL('../../mac/patchers/desktop/', import.meta.url)],
      ['mac-x64', new URL('../../mac/patchers/desktop/x64/', import.meta.url)],
      ['linux-x64', new URL('../../linux/patchers/desktop/', import.meta.url)],
      ['linux-arm64', new URL('../../linux/patchers/desktop/arm64/', import.meta.url)],
    // The Windows, Android and web packages ship without linux/.
    ].filter(([, dir]) => existsSync(new URL('recipes/manifest.json', dir))).map(async ([label, dir]) => {
      const m = JSON.parse(await readFile(new URL('recipes/manifest.json', dir), 'utf8'));
      const list = await Promise.all(m.files.map(async entry => ({
        entry, recipe: JSON.parse(gunzipSync(await readFile(new URL(`recipes/${entry.recipe}`, dir)))),
      })));
      return { label, list };
    })),
  ];
  for (const name of names) {
    const source = await readFile(new URL(name, extensions));
    for (const { label, list } of targets) {
      const carriers = list.filter(({ recipe }) => addedBytes(recipe).includes(source));
      assert.equal(carriers.length, 1, `${name} is not in exactly one ${label} recipe; rerun windows/tools/desktop-recipes/build.mjs --target ${label}`);
    }
  }
  const updateView = await readFile(new URL('update-view.js', extensions), 'utf8');
  assert.match(updateView, /\(0,\s*x\.jsx\)\(h,\s*\{/, '1.3.0 update-view must render inside settings section h, not presentation hook g');
  const computerView = await readFile(new URL('computer-view.js', extensions), 'utf8');
  assert.match(computerView, /anchorId:\s*'bot-computer'/, '1.3.0 computer-view must preserve official bot-computer anchorId');
  const computerSpec = SPEC.find(entry => entry.path.includes('chunk-view-_JwVsmv_.js'));
  assert.ok(computerSpec?.edits.some(edit => edit.text?.includes('children:[i,a,o,(0,Q.jsx)(GrokRemoteDesktop,{})]')),
    '1.3.0 Settings > Computer must keep official section order (Your computer at top, Bot computer at bottom)');
});

test('a replacement copies the original bytes it shares at either end', () => {
  const source = Buffer.from('let a=1;function f(){return old(x)}export{f};');
  const { recipe, target, added } = buildRecipe({ path: 'fixture.js', edits: [
    { replace: 'return old(x)', text: 'return new(x)' }, { prepend: 'P;' }, { append: ';Z' },
    { insertAfter: 'let a=1;', text: '/*i*/' }] }, source);
  assert.equal(target.toString(), 'P;let a=1;/*i*/function f(){return new(x)}export{f};;Z');
  assert.equal(added, 'P;'.length + '/*i*/'.length + 'new'.length + ';Z'.length);
  assert.deepEqual(applyByteRecipe(source, recipe), target);
  assert.equal(recipe.sourceSha256, sha(source));
  assert.equal(recipe.targetSha256, sha(target));
});

test('a missing or repeated anchor and overlapping edits are refused', () => {
  const source = Buffer.from('abcd abcd efgh');
  assert.throws(() => buildRecipe({ path: 'x', edits: [{ replace: 'abcd', text: '' }] }, source), /not unique/);
  assert.throws(() => buildRecipe({ path: 'x', edits: [{ insertBefore: 'zzz', text: '' }] }, source), /not found/);
  assert.throws(() => buildRecipe({ path: 'x', edits: [{ replace: 'efg', text: '1' }, { replace: 'fgh', text: '2' }] }, source),
    /overlapping/);
});
