import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { applyByteRecipe } from '../../../../mac/patchers/desktop/release-recipes.mjs';
import { find } from './ast.mjs';
import { researchInput, withCandidate } from './candidate.mjs';
import { inspectCandidateIpc } from './ipc.mjs';
import { plan } from './ui.mjs';

const rules = { library: 'file-library.recipe.json', empty: 'empty-label.recipe.json' };
const plain = v => JSON.parse(JSON.stringify(v));

// Only isolated, digest-bound UI helpers are called. No vendor module or preload is imported.
function realm(snippets) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(snippets.join('\n')).runInContext(context, { timeout: 250 });
  return (expr, input) => {
    context.fixtureText = JSON.stringify(input);
    return plain(new vm.Script(`(p => (${expr}))(JSON.parse(fixtureText))`).runInContext(context, { timeout: 250 }));
  };
}
function replayLibrary(m, { batch, errors }, staged) {
  const decl = new Map(), helperImports = new Set();
  function use(fn) {
    if (decl.has(fn.id.name)) return;
    decl.set(fn.id.name, m.text(fn));
    for (const c of find(fn, n => n.type === 'CallExpression' && n.callee.type === 'Identifier')) {
      const local = c.callee.name;
      if (fn.params.some(p => p.name === local)) continue;
      if (local === 'Number' && !m.defs.has(local) && !m.imports.has(local)) continue;
      if (m.imports.has(local)) { helperImports.add(local); continue; }
      const dep = m.defs.get(local); assert.equal(dep?.type, 'FunctionDeclaration'); use(dep);
      for (const a of c.arguments) if (a.type === 'Identifier' && m.defs.get(a.name)?.type === 'Literal') {
        const node = m.defs.get(a.name); assert.equal(typeof node.value, 'number'); decl.set(a.name, `const ${a.name}=${node.value};`);
      }
    }
  }
  use(batch); use(errors); assert.equal(helperImports.size, 1, 'only the name-list formatter may be mocked');
  assert.equal(decl.size, 9, 'selection/display helper closure changed');
  const run = realm([...[...helperImports].map(k => `const ${k}=items=>items.join(', ');`), ...decl.values()]);
  let cases = 0;
  function pick(files, count, total, accepted, skipped) {
    const selection = run(`${batch.id.name}(p.files,{files:Array(p.count).fill(null),totalBytes:p.total})`, { files, count, total });
    assert.deepEqual(selection.accepted.map(f => f.name), accepted);
    assert.deepEqual(selection.skipped.map(f => f.reason), skipped); cases++;
  }
  const mb = 1024 ** 2, cap = (staged ? 20 : 25) * mb, count = staged ? 100 : 200, total = (staged ? 100 : 1024) * mb;
  const file = (size, name = 'sample.txt') => ({ name, size });
  pick([file(0)], 0, 0, [], ['empty']);
  pick([file(1, '.hidden')], 0, 0, [], ['hidden-name']);
  pick([file(cap - 1)], 0, 0, ['sample.txt'], []);
  pick([file(cap)], 0, 0, ['sample.txt'], []);
  pick([file(cap + 1)], 0, 0, [], ['too-large']);
  pick([file(1)], count - 1, 0, ['sample.txt'], []);
  pick([file(1)], count, 0, [], ['too-many-files']);
  pick([file(1)], count + 1, 0, [], ['too-many-files']);
  pick([file(1)], 0, total - 2, ['sample.txt'], []);
  pick([file(1)], 0, total - 1, ['sample.txt'], []);
  pick([file(1)], 0, total, [], ['over-total-bytes']);
  pick([file(1, 'a'), file(1, 'b')], count - 1, 0, ['a'], ['too-many-files']);
  pick([file(1, 'a'), file(1, 'b')], 0, total - 1, ['a'], ['over-total-bytes']);
  pick([file(22 * mb)], 0, 0, staged ? [] : ['sample.txt'], staged ? ['too-large'] : []);
  pick([file(1)], 100, 0, staged ? [] : ['sample.txt'], staged ? ['too-many-files'] : []);
  pick([file(1)], 0, 100 * mb, staged ? [] : ['sample.txt'], staged ? ['over-total-bytes'] : []);
  const messages = run(`${errors.id.name}(descriptor=>descriptor,p)`, ['too-large','too-many-files','over-total-bytes'].map(reason => ({ file: file(1), reason })));
  const limits = messages.map(d => d.values.limit);
  assert.deepEqual(limits, [staged ? '20 MB' : '25 MB', count, staged ? '100 MB' : '1 GB']);
  return { selectionCases: cases, displayLimits: limits };
}

function replayEmpty(m, model, staged, stockModel) {
  const run = realm([`const ${stockModel.loadingKey}={id:'fixture-loading'},${stockModel.emptyKey}={id:'fixture-empty'};`, m.text(model.fn)]);
  function render(locale, fallback, loading, query) {
    return run(`(globalThis.document={documentElement:{lang:p.locale}},globalThis.navigator={language:p.fallback},${model.fn.id.name}(d=>d,{isLoading:p.loading,query:p.query}))`, { locale, fallback, loading, query });
  }
  const pairs = [['en-US','zh-CN',false],['zh-CN','en-US',true],['zh-TW','en-US',true],['','zh-CN',true],['','fr-FR',false]];
  for (const [locale, fallback, chinese] of pairs) {
    assert.deepEqual(render(locale,fallback,true,'  typed '), { id: 'fixture-loading' });
    assert.deepEqual(render(locale,fallback,false,'  typed '), { id: 'mLyVIn', values: { trimmed: 'typed' } });
    for (const q of ['', '  ']) assert.deepEqual(render(locale,fallback,false,q), staged ? chinese ? '\u6ca1\u6709\u5df2\u8fde\u63a5\u7684\u5e94\u7528' : 'No connected apps' : { id: 'fixture-empty' });
  }
  return { presentationCases: pairs.length * 4, exportedConsumers: 2 };
}

export function verify(file, platform = 'windows') {
  const { identity, members } = researchInput(platform);
  return withCandidate(file, (read, packed) => {
    const ipc = platform === 'windows' ? inspectCandidateIpc(read('preload')) : null, ui = {};
    for (const [role, filename] of Object.entries(rules)) {
      const bytes = read(role), { recipe, m, model, changed, after } = plan(role, bytes, platform);
      const staged = JSON.parse(readFileSync(new URL(filename, import.meta.url), 'utf8'));
      if (platform === 'windows') assert.deepEqual(staged, recipe, 'staged rule differs from independent source-bound generation');
      else {
        assert.throws(() => applyByteRecipe(bytes, staged), /input fingerprint/, 'Windows recipe must reject these Mac bytes');
        assert.deepEqual(recipe.ops.filter(([op]) => op === 'add'), staged.ops.filter(([op]) => op === 'add'), 'project-owned additions differ');
      }
      const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
      assert.throws(() => applyByteRecipe(corrupt, recipe), /input fingerprint/);
      assert.throws(() => applyByteRecipe(bytes, { ...recipe, targetSha256: '0'.repeat(64) }), /fingerprint/);
      const imports = new Set([...m.imports.values()]);
      for (const relative of imports) { assert.ok(relative.startsWith('./')); assert.ok(packed(path.posix.join(path.posix.dirname(members[role][0]), relative))); }
      const additions = recipe.ops.filter(([op]) => op === 'add');
      const kinds = role === 'library' ? [replayLibrary(m,model,false), replayLibrary(changed,after,true)] : [replayEmpty(m,model,false,model), replayEmpty(changed,after,true,model)];
      ui[role] = { sourceSha256: recipe.sourceSha256, targetSha256: recipe.targetSha256, sourceBytes: bytes.length,
        windowsRecipeAccepted: platform === 'windows', sameOperationSequence: JSON.stringify(recipe.ops) === JSON.stringify(staged.ops),
        edits: additions.length, projectAddedBytes: additions.reduce((sum, [,v]) => sum + Buffer.from(v, 'base64').length, 0), upstreamAddedBytes: 0,
        directImportFilesInHeader: imports.size, stock: kinds[0], staged: kinds[1] };
    }
    return { platform: identity.platform, version: identity.version, headerSha256: identity.headerSha256, inspectedMemberBytes: (ipc?.bytes ?? 0) + ui.library.sourceBytes + ui.empty.sourceBytes,
      provenance: platform === 'windows' ? 'archive digest and signer from main; header and selected members recomputed' : 'archive digest and plist check from main; header and two UI members recomputed; no native signature check', ipc, ui, nativeTested: false };
  }, platform);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === '--mac-ui')) {
    console.error('Usage: node --expose-internals verify.mjs <coordinator-verified ASAR> [--mac-ui]'); process.exitCode = 1;
  } else console.log(JSON.stringify(verify(process.argv[2], process.argv[3] ? 'mac' : 'windows'), null, 2));
}
