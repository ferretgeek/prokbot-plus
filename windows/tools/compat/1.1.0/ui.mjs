import assert from 'node:assert/strict';
import { applyByteRecipe } from '../../../../mac/patchers/desktop/release-recipes.mjs';
import { researchInput, sha } from './candidate.mjs';
import { calls, find, moduleShape, name, only, prop, value } from './ast.mjs';

// These are the only possible additions. Never derive added bytes from parsed vendor text.
const own = Object.freeze({ file: String(20 * 1024 * 1024), count: String(100), total: String(100 * 1024 * 1024),
  label: '(/^zh(?:-|$)/i.test(globalThis.document?.documentElement?.lang || globalThis.navigator?.language || "en") ? "\\u6ca1\\u6709\\u5df2\\u8fde\\u63a5\\u7684\\u5e94\\u7528" : "No connected apps")' });
const stock = { file: 26214400, count: 200, total: 1073741824 };
const references = (fn, id) => find(fn, n => n.type === 'Identifier' && n.name === id);
const lookupNumber = (fn, num) => only(find(fn, n => n.type === 'Literal' && n.value === num), `numeric slot ${num}`);
const firstReturn = n => n?.body?.body?.find(s => s.type === 'ReturnStatement')?.argument;

function library(m, expected) {
  const wanted = ['empty', 'too-large', 'too-many-files', 'over-total-bytes'];
  const verdict = only(m.functions.filter(f => wanted.every(w => find(f, n => n.type === 'ObjectExpression' && value(prop(n, 'kind')) === w).length === 1)), 'file-library preflight');
  const [file, stats] = verdict.params.map(p => p.name);
  const memberIs = (n, bind, field) => n?.type === 'MemberExpression' && !n.computed && n.object.name === bind && n.property.name === field;
  let clause = firstReturn(verdict);
  const edits = [];
  for (const [i, [op, num, addition]] of [['<=', 0], ['>', expected.file, 'file'], ['>=', expected.count, 'count'], ['>', expected.total, 'total']].entries()) {
    assert.equal(clause.type, 'ConditionalExpression'); assert.equal(value(prop(clause.consequent, 'kind')), wanted[i]);
    const cond = clause.test;
    assert.equal(cond.operator, op); assert.equal(cond.right.type, 'Literal'); assert.equal(cond.right.value, num);
    if (i < 2) assert.ok(memberIs(cond.left, file, 'sizeBytes'));
    else if (i === 2) assert.ok(memberIs(cond.left, stats, 'fileCount'));
    else { assert.equal(cond.left.operator, '+'); assert.ok(memberIs(cond.left.left, stats, 'totalBytes') && memberIs(cond.left.right, file, 'sizeBytes')); }
    if (addition) edits.push([cond.right, addition]);
    clause = clause.alternate;
  }
  assert.equal(clause.type, 'Literal'); assert.equal(clause.value, null);
  const batch = only(m.functions.filter(f => calls(f, verdict.id.name).length === 1), 'file picker batch caller');
  const errors = only(m.functions.filter(f => f !== verdict && wanted.every(w => find(f, n => value(n) === w).length === 1)), 'localized preflight errors');
  for (const slot of ['file', 'total']) {
    const [binding, n] = only([...m.defs].filter(([k, v]) => value(v) === expected[slot] && references(errors, k).length === 1), `${slot} display constant`);
    const formatter = only(find(errors, x => x.type === 'CallExpression' && x.arguments.length === 1 && x.arguments[0].name === binding), 'display formatter');
    assert.ok([...m.exports.values()].includes(formatter.callee.name)); edits.push([n, slot]);
  }
  const count = lookupNumber(errors, expected.count);
  only(find(errors, n => n.type === 'Property' && name(n) === 'limit' && n.value === count), 'localized count limit');
  edits.push([count, 'count']);
  const summary = only(m.functions.filter(f => calls(f, errors.id.name).length === 1), 'batch result presentation');
  const hook = only(m.functions.filter(f => [...m.exports.values()].includes(f.id.name) && calls(f, batch.id.name).length === 1 && calls(f, summary.id.name).length === 1), 'exported file-picker hook');
  const exported = only(find(m.tree, n => n.type === 'Property' && name(n) === 'useStoreFilesUpload'), 'named upload hook');
  assert.equal(exported.value.body.name, hook.id.name);
  return { edits, verdict, batch, errors };
}

function empty(m, staged) {
  const fn = only(m.functions.filter(f => find(f, n => value(n) === 'mLyVIn').length === 1 && f.params.length === 2
    && find(f, n => n.type === 'MemberExpression' && n.property.name === 'isLoading').length === 1), 'loading/query/empty label');
  const [translate, state] = fn.params.map(n => n.name), [loading, trimmed, ret] = fn.body.body;
  assert.equal(fn.body.body.length, 3); assert.equal(loading.type, 'IfStatement');
  assert.equal(loading.test.object.name, state); assert.equal(loading.test.property.name, 'isLoading');
  assert.equal(loading.consequent.argument.callee.name, translate);
  const loadingKey = loading.consequent.argument.arguments[0].name; assert.ok(m.imports.has(loadingKey));
  const query = trimmed.declarations[0];
  assert.equal(query.init.callee.property.name, 'trim'); assert.equal(query.init.callee.object.object.name, state);
  assert.equal(query.init.callee.object.property.name, 'query');
  const choice = ret.argument; assert.equal(choice.type, 'ConditionalExpression');
  assert.equal(choice.test.operator, '>'); assert.equal(choice.test.left.object.name, query.id.name); assert.equal(choice.test.left.property.name, 'length');
  assert.equal(value(choice.test.right), 0); assert.equal(choice.consequent.callee.name, translate);
  assert.equal(value(prop(choice.consequent.arguments[0], 'id')), 'mLyVIn');
  assert.equal(prop(prop(choice.consequent.arguments[0], 'values'), 'trimmed').name, query.id.name);
  let emptyKey;
  if (!staged) { assert.equal(choice.alternate.callee.name, translate); emptyKey = choice.alternate.arguments[0].name; assert.ok(m.imports.has(emptyKey)); }
  else assert.equal(choice.alternate.type, 'ConditionalExpression');
  const consumers = m.functions.filter(f => calls(f, fn.id.name).length > 0);
  assert.equal(consumers.length, 2); assert.ok(consumers.every(f => [...m.exports.values()].includes(f.id.name)));
  const states = consumers.map(f => calls(f, fn.id.name)[0].arguments[1]);
  assert.ok(states.every(s => prop(s, 'isLoading')?.type === 'Identifier'));
  assert.ok(states.some(s => value(prop(s, 'query')) === '') && states.some(s => prop(s, 'query')?.type === 'Identifier'));
  return { edits: [[choice.alternate, 'label']], fn, loadingKey, emptyKey };
}

function make(src, m, edits) {
  const ops = [], chunks = []; let cursor = 0;
  const copy = end => { if (end > cursor) { ops.push(['copy', cursor, end - cursor]); chunks.push(src.subarray(cursor, end)); } };
  for (const [node, id] of edits.sort((a, b) => a[0].start - b[0].start)) {
    assert.ok(Object.hasOwn(own, id));
    const lo = Buffer.byteLength(m.src.slice(0, node.start)), hi = Buffer.byteLength(m.src.slice(0, node.end));
    assert.ok(cursor <= lo && lo < hi && hi <= src.length); copy(lo);
    const addition = Buffer.from(own[id], 'ascii');
    ops.push(['add', addition.toString('base64')]); chunks.push(addition); cursor = hi;
  }
  copy(src.length);
  const target = Buffer.concat(chunks);
  const recipe = { schema: 'grokbot-bytepatch/v1', sourceBytes: src.length, sourceSha256: sha(src), targetBytes: target.length, targetSha256: sha(target), ops };
  assert.deepEqual(applyByteRecipe(src, recipe), target);
  return recipe;
}

export function plan(role, bytes, platform = 'windows') {
  assert.ok(role === 'library' || role === 'empty'); assert.equal(sha(bytes), researchInput(platform).members[role][1]);
  const m = moduleShape(bytes), model = role === 'library' ? library(m, stock) : empty(m, false);
  const recipe = make(bytes, m, model.edits);
  const changed = moduleShape(applyByteRecipe(bytes, recipe));
  const after = role === 'library' ? library(changed, Object.fromEntries(Object.keys(stock).map(k => [k, Number(own[k])]))) : empty(changed, true);
  assert.deepEqual([...m.exports], [...changed.exports]); assert.deepEqual([...m.imports], [...changed.imports]);
  return { recipe, m, model, changed, after };
}
