// Research verifier: reads only pinned renderer members. No vendor module is executed or written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { applyByteRecipe } from '../../../../mac/patchers/desktop/release-recipes.mjs';
import { resolveAnchorExpression } from '../../../client/anchor-fallback.js';
import { activityTime } from '../../../client/layout.js';

const [archive, intakeFile] = process.argv.slice(2);
if (!archive || !intakeFile || process.argv.length !== 4) throw Error('Usage: node --expose-internals verify-layout.mjs <stock-windows.asar> <authenticated-intake.json>');
const require = createRequire(new URL('../../../../mac/patchers/desktop/package.json', import.meta.url));
const asar = require('@electron/asar');
const acorn = require('internal/deps/acorn/acorn/dist/acorn'); // Node's bundled parser, research only.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = JSON.parse(readFileSync(new URL('./layout-candidate.json', import.meta.url), 'utf8'));
const intake = JSON.parse(readFileSync(intakeFile, 'utf8'));
assert.equal(candidate.schema, 'prokbot-android-layout-candidate/v1');
assert.equal(candidate.status, 'offline-candidate-only');
assert.equal(candidate.sourceStage, 'stock-windows-x64');
assert.equal(intake.platform, 'windows');
assert.equal(intake.version, candidate.version);
assert.equal(intake.asarSha256, candidate.asarSha256); // Full-file provenance was established at intake.
assert.equal(intake.headerSha256, candidate.headerSha256);
const prefix = Buffer.alloc(8), fd = openSync(archive, 'r');
try { assert.equal(readSync(fd, prefix, 0, 8, 0), 8); } finally { closeSync(fd); }
assert.equal(prefix.readUInt32LE(4), candidate.headerBytes, 'unexpected header size');
const header = asar.getRawHeader(archive);
assert.equal(header.headerSize, candidate.headerBytes);
assert.equal(sha(header.headerString), candidate.headerSha256, 'stock header digest');

const asset = name => `dist/renderer/assets/${name}`;
const htmlPath = 'dist/renderer/index.html', entryPath = asset('index-DcdocK0f.js');
const memoPath = asset('chunk-voice-memo-bubble-rtizntXn.js');
const eagerPath = asset('index.eager-app-BwKPFs1J.js'), previewPath = asset('chunk-computer-screen-preview-DUJrLdj0.js');
assert.deepEqual(Object.keys(candidate.witnesses).sort(), [htmlPath, entryPath, memoPath].sort());
assert.deepEqual(candidate.targets.map(t => t.file), [eagerPath, previewPath]);
function member(file, pin) {
  let node = header.header;
  for (const part of file.split('/')) {
    assert.ok(Object.hasOwn(node.files, part), file);
    node = node.files[part];
    assert.ok(!node.unpacked && !node.link, file);
  }
  assert.ok(Number.isSafeInteger(node.size) && node.size > 0 && node.size <= 6 * 1024 * 1024, file);
  assert.equal(node.integrity.algorithm, 'SHA256');
  assert.equal(node.integrity.hash, pin, file);
  if (Object.hasOwn(intake.members, file)) assert.equal(intake.members[file], pin, file);
  const bytes = asar.extractFile(archive, path.normalize(file), false);
  assert.equal(bytes.length, node.size);
  assert.equal(sha(bytes), pin, file);
  return bytes;
}

function replay(t, source) {
  let end = 0;
  const ops = [];
  for (const { at, add } of t.insertions) {
    assert.ok(Number.isSafeInteger(at) && at > end && at < source.length && typeof add === 'string' && add.length > 0);
    ops.push(['copy', end, at - end], ['add', Buffer.from(add).toString('base64')]);
    end = at;
  }
  ops.push(['copy', end, source.length - end]);
  const recipe = { schema: 'grokbot-bytepatch/v1', sourceBytes: t.sourceBytes, sourceSha256: t.sourceSha256,
    targetBytes: t.targetBytes, targetSha256: t.targetSha256, ops };
  const patched = applyByteRecipe(source, recipe);
  // Independent reconstruction from the end of the untouched source, not from COPY/ADD ops.
  end = source.length;
  const chunks = [];
  for (const { at, add } of t.insertions.toReversed()) {
    chunks.push(source.subarray(at, end), Buffer.from(add)); end = at;
  }
  chunks.push(source.subarray(0, end));
  assert.deepEqual(patched, Buffer.concat(chunks.reverse()));
  const drift = Buffer.from(source); drift[0] ^= 1;
  assert.throws(() => applyByteRecipe(drift, recipe), /input fingerprint/);
  assert.throws(() => applyByteRecipe(patched, recipe), /input fingerprint/);
  assert.throws(() => applyByteRecipe(source, { ...recipe, targetSha256: '0'.repeat(64) }), /output fingerprint/);
  return patched;
}

function find(node, predicate, out = []) {
  if (!node?.type) return out;
  if (predicate(node)) out.push(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) { for (const x of child) if (x?.type) find(x, predicate, out); }
    else if (child?.type) find(child, predicate, out);
  }
  return out;
}
function only(values, why) { assert.equal(values.length, 1, `${why}: ${values.length} matches`); return values[0]; }
const literal = n => n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : n?.value;
const key = p => p.key?.name ?? literal(p.key);
const prop = (n, k) => n?.properties?.find(p => key(p) === k)?.value;
const calls = (node, name) => find(node, n => n.type === 'CallExpression' && n.callee.name === name);
function moduleInfo(bytes) {
  const text = bytes.toString('utf8');
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const decl = new Map(), imports = new Map(), exports = new Map();
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration') decl.set(st.id.name, st);
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) decl.set(d.id.name, d.init);
    if (st.type === 'ImportDeclaration') for (const p of st.specifiers) imports.set(p.local.name, [st.source.value, p.imported?.name]);
    if (st.type === 'ExportNamedDeclaration') for (const p of st.specifiers) exports.set(p.exported.name, p.local.name);
  }
  return { ast, text, decl, imports, exports };
}
const isAndroid = n => n?.type === 'BinaryExpression' && n.operator === '===' && literal(n.right) === 'android' &&
  n.left.type === 'ChainExpression' && n.left.expression.property.name === 'platform' && n.left.expression.optional === true &&
  n.left.expression.object.property.name === 'localBot' && n.left.expression.object.object.name === 'globalThis';

assert.equal(intake.members[htmlPath], candidate.witnesses[htmlPath]);
assert.equal(intake.members[entryPath], candidate.witnesses[entryPath]);
const html = member(htmlPath, candidate.witnesses[htmlPath]).toString('utf8');
const entryScript = only([...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/g)], 'HTML entry')[1];
assert.equal(path.posix.join('dist/renderer', entryScript), entryPath);
const entry = moduleInfo(member(entryPath, candidate.witnesses[entryPath]));
const eagerName = `./${path.posix.basename(eagerPath)}`;
assert.ok(find(entry.ast, n => ['ImportDeclaration', 'ImportExpression'].includes(n.type) && literal(n.source) === eagerName).length > 0);
const memo = moduleInfo(member(memoPath, candidate.witnesses[memoPath]));
const originals = candidate.targets.map(t => member(t.file, t.sourceSha256));
const outputs = candidate.targets.map((t, i) => replay(t, originals[i]));
const [eager, preview] = originals.map(moduleInfo), [next, nextPreview] = outputs.map(moduleInfo);
const offsets = {};
const mark = (mod, id, pos) => { offsets[id] = Buffer.byteLength(mod.text.slice(0, pos)); };

// The fit predicate, missing pane width and sidebar expansion are distinct helpers, not general resize controls.
for (const [id, name, value, callers] of [
  ['details-fit', 'YD', true, [['p_r', 3], ['UEr', 1]]],
  ['details-expansion', 'Gat', 0, [['p_r', 1]]], ['sidebar-expansion', 'Kat', 0, [['ylt', 1]]],
]) {
  const before = eager.decl.get(name).body, after = next.decl.get(name).body;
  mark(eager, id, before.start + 1);
  assert.ok(find(before, n => n.property?.name === 'windowWidth').length > 0);
  for (const [owner, count] of callers) assert.equal(calls(eager.decl.get(owner), name).length, count, owner);
  assert.equal(after.body[0].type, 'IfStatement'); assert.ok(isAndroid(after.body[0].test));
  assert.equal(literal(after.body[0].consequent.argument), value);
  assert.equal(next.text.slice(after.body[0].end, after.end), eager.text.slice(before.start + 1, before.end));
}
assert.ok(find(eager.decl.get('Bkt'), n => literal(n) === 'sand-info-pane__inner').length > 0);
assert.ok(find(eager.decl.get('Bkt'), n => n.type === 'Property' && key(n) === 'data-open').length > 0);

// The formatter must enter before the row element's memo comparison, outside the status-indicator cache.
function row(mod) {
  const fn = mod.decl.get('eyt');
  const status = only(find(fn, n => n.type === 'AssignmentExpression' && n.right.type === 'ConditionalExpression' &&
    n.right.consequent.arguments?.[0]?.name === 'Jvt' && literal(n.right.alternate) === null), 'row status');
  const statement = only(fn.body.body.filter(n => n.start <= status.start && n.end >= status.end), 'status cache statement');
  const api = only(find(fn, n => n.type === 'ObjectExpression' && prop(n, 'time')?.name === status.left.name), 'row time prop');
  const agent = prop(api, 'data-agent-id').object.name;
  const comparison = only(find(fn, n => n.type === 'BinaryExpression' && n.operator === '!==' &&
    n.left.type === 'MemberExpression' && n.right.name === status.left.name), 'row element memo dependency');
  assert.ok(statement.end < comparison.start && comparison.end < api.start);
  return { fn, statement, comparison, agent, slot: status.left.name };
}
const oldRow = row(eager), newRow = row(next);
mark(eager, 'row-time', oldRow.statement.end);
const fallback = only(find(newRow.fn, n => n.type === 'AssignmentExpression' && n.operator === '??=' && n.left.name === newRow.slot), 'row fallback');
assert.ok(newRow.statement.end <= fallback.start && fallback.end < newRow.comparison.start);
const format = only(find(fallback, n => n.type === 'CallExpression' && n.optional && n.callee.property?.name === 'grokbotActivityTime'), 'project row formatter');
assert.equal(format.callee.object.name, 'globalThis');
assert.equal(format.arguments[0].object.name, newRow.agent); assert.equal(format.arguments[0].property.name, 'lastActivityAt');
assert.equal(literal(fallback.right.right), null);
assert.ok(find(eager.decl.get('Jvt'), n => n.type === 'Property' && key(n) === 'role' && literal(n.value) === 'status').length > 0);
assert.ok(find(eager.decl.get('Rw'), n => literal(n) === 'sand-agent-item__time').length > 0);
const now = new Date(2026, 0, 2, 12).getTime();
assert.equal(activityTime(null, now, 'en'), null);
assert.equal(activityTime(new Date(2026, 0, 1, 18).getTime(), now, 'en'), 'Yesterday');

// Select this menu item by its translated label and action, not the position in the account menu.
const catalog = JSON.parse(literal(eager.decl.get('Ho').arguments[0]));
assert.ok(JSON.stringify(catalog.RnO9TC).includes('Get Grok Bot for mobile'));
function mobileMenu(mod) {
  const fn = mod.decl.get('Nht');
  assert.equal(find(fn, n => literal(n) === 'get_mobile').length, 1);
  const label = only(find(fn, n => n.type === 'AssignmentExpression' &&
    literal(prop(n.right.arguments?.[1], 'id')) === 'RnO9TC'), 'translated mobile label').left.name;
  const item = only(find(fn, n => n.type === 'CallExpression' && n.arguments[0]?.property?.name === 'Item' &&
    prop(n.arguments[1], 'onSelect') && prop(n.arguments[1], 'children')?.name === label), 'mobile menu item');
  return { fn, item };
}
const oldMenu = mobileMenu(eager), newMenu = mobileMenu(next);
mark(eager, 'mobile-app-menu', oldMenu.item.start);
const menuGuard = only(find(newMenu.fn, n => n.type === 'ConditionalExpression' && n.alternate === newMenu.item), 'mobile menu guard');
assert.ok(isAndroid(menuGuard.test)); assert.equal(literal(menuGuard.consequent), null);
assert.equal(next.text.slice(newMenu.item.start, newMenu.item.end), eager.text.slice(oldMenu.item.start, oldMenu.item.end));

function teachingProps(mod) {
  return only(find(mod.decl.get('dRn'), n => n.type === 'ConditionalExpression' && n.consequent.type === 'ObjectExpression' &&
    !n.consequent.properties.length && n.alternate.properties?.length === 1 && prop(n.alternate, 'onTeachClick')), 'composer teaching callback');
}
const oldTeach = teachingProps(eager), newTeach = teachingProps(next);
mark(eager, 'teach-action', oldTeach.test.start);
assert.equal(newTeach.test.operator, '||'); assert.ok(isAndroid(newTeach.test.left));
assert.equal(next.text.slice(newTeach.test.right.start, newTeach.test.right.end), eager.text.slice(oldTeach.test.start, oldTeach.test.end));

// Follow the memo hook's imports into the eager module. Other numeric arrays are unrelated.
const hook = memo.decl.get('Ce');
const cycle = only(find(hook, n => n.type === 'CallExpression' && n.arguments.length === 2 &&
  memo.imports.has(n.callee.name) && memo.imports.has(n.arguments[0].name)), 'voice memo cycle');
function imported(mod, local) {
  const [source, name] = memo.imports.get(local);
  assert.equal(source, eagerName);
  const binding = mod.exports.get(name);
  assert.ok(mod.decl.has(binding), name);
  return binding;
}
const rateName = imported(eager, cycle.arguments[0].name);
const list = eager.decl.get(rateName), rates = list.elements.map(literal);
assert.deepEqual(rates, [1, 1.5, 2]);
mark(eager, 'memo-rate', list.elements[0].end);
assert.deepEqual(next.decl.get(imported(next, cycle.arguments[0].name)).elements.map(literal), [1, 1.25, 1.5, 2]);
const cycleFn = eager.decl.get(imported(eager, cycle.callee.name));
assert.ok(find(cycleFn, n => n.type === 'MemberExpression' && n.property.name === 'indexOf' && n.object.name === cycleFn.params[0].name).length);
const selection = only(find(hook, n => n.type === 'VariableDeclarator' && n.init === cycle), 'next speed local').id.name;
const setter = only(find(hook, n => n.type === 'Property' && key(n) === 'setPlaybackRate'), 'speed setter').value.name;
assert.ok(calls(hook, setter).some(c => c.arguments[0]?.name === selection));
const match = only(find(eager.decl.get('$Gr'), n => n.type === 'CallExpression' && n.callee.object?.name === rateName &&
  n.callee.property.name === 'find'), 'persisted speed decoder');
assert.equal(match.arguments[0].body.operator, '===');
const store = eager.decl.get('nKr');
const restore = only(find(store, n => n.type === 'Property' && key(n) === 'restore'), 'rate store restore').value;
assert.ok(calls(restore, '$Gr').some(c => c.arguments[0]?.property.name === 'value' && c.arguments[0].object.property.name === 'envelope'));
assert.ok(find(store, n => n.type === 'CallExpression' && n.callee.property?.name === 'register' && n.callee.object.property?.name === 'registry').length);
for (const name of ['a$t', 'o$t', 'u$t']) assert.deepEqual(next.decl.get(name).elements.map(literal), eager.decl.get(name).elements.map(literal));

// Preview port, preview frame and expanded-stage frame must keep their own positionAnchor.
const owner = preview.decl.get('be');
const rect = { top: 31, left: 47, width: 120, height: 86 }, box = { top: 11, left: 17, width: 360, height: 600 };
const pixels = { top: '20px', left: '30px', right: '210px', bottom: '494px', width: '120px', height: '86px' };
for (const [id, name, properties, anchorName] of [
  ['preview-edges', '_e', ['top', 'right', 'bottom', 'left'], '--sand-computer-preview-port'],
  ['preview-size', 'q', ['top', 'left', 'width', 'height'], '--sand-computer-preview-frame'],
]) {
  const before = preview.decl.get(name), after = nextPreview.decl.get(name);
  const [source, symbol] = preview.imports.get(prop(before, 'positionAnchor').name);
  assert.equal(source, eagerName); assert.equal(literal(eager.decl.get(eager.exports.get(symbol))), anchorName);
  mark(preview, id, before.end - 1);
  assert.deepEqual(before.properties.map(key), ['positionAnchor', ...properties]);
  assert.deepEqual(after.properties.map(key), [...before.properties.map(key), ...properties.map(k => `--grokbot-anchor-${k}`)]);
  for (const k of properties) {
    const value = literal(prop(after, `--grokbot-anchor-${k}`));
    assert.equal(value, literal(prop(before, k))); assert.equal(literal(prop(after, k)), value);
    assert.equal(resolveAnchorExpression(value, k, rect, box), pixels[k]);
  }
  const choice = only(find(owner, n => n.type === 'VariableDeclarator' && n.init?.type === 'ConditionalExpression' &&
    n.init.consequent.name === name), 'rendered preview style');
  assert.ok(find(owner, n => n.type === 'Property' && key(n) === 'style' && n.value.name === choice.id.name).length);
}
const expanded = nextPreview.decl.get('ve');
assert.equal(expanded.properties[0].type, 'SpreadElement'); assert.equal(expanded.properties[0].argument.name, 'q');
const [stageSource, stageSymbol] = nextPreview.imports.get(prop(expanded, 'positionAnchor').name);
assert.equal(stageSource, eagerName); assert.equal(literal(eager.decl.get(eager.exports.get(stageSymbol))), '--sand-computer-stage-frame');
assert.ok(find(eager.ast, n => n.type === 'ImportExpression' && literal(n.source) === `./${path.posix.basename(previewPath)}`).length);

const edits = candidate.targets.flatMap(t => t.insertions);
assert.equal(edits.length, new Set(edits.map(e => e.id)).size);
assert.deepEqual(offsets, Object.fromEntries(edits.map(e => [e.id, e.at])));
console.log(JSON.stringify({ version: candidate.version, stage: candidate.sourceStage, matchedMembers: 5,
  legacyLayoutEdits: 7, additionalMemoRates: [1.25], insertions: edits.length,
  replay: 'byte recipe and independent reverse reconstruction matched; parsed source and result',
  outputs: candidate.targets.map(t => ({ file: t.file, bytes: t.targetBytes, sha256: t.targetSha256 })),
  vendorCodeExecuted: false, artifactsWritten: false, runtimeVerified: false }, null, 2));
