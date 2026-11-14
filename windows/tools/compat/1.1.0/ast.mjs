import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const name = p => p?.key?.name ?? value(p?.key);
export const value = n => n?.type === 'Literal' ? n.value : n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : undefined;
export const prop = (n, k) => n?.properties?.find(p => name(p) === k)?.value;
export function find(root, predicate) {
  const hits = [], stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n?.type) continue;
    if (predicate(n)) hits.push(n);
    for (const child of Object.values(n)) {
      if (Array.isArray(child)) { for (const item of child) if (item?.type) stack.push(item); }
      else if (child?.type) stack.push(child);
    }
  }
  return hits;
}
export function only(matches, label) { assert.equal(matches.length, 1, `ambiguous or absent: ${label}`); return matches[0]; }
export const calls = (n, id) => find(n, v => v.type === 'CallExpression' && v.callee.name === id);
export function moduleShape(bytes, sourceType = 'module') {
  const src = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const { parse } = require('internal/deps/acorn/acorn/dist/acorn');
  const tree = parse(src, { ecmaVersion: 'latest', sourceType });
  const defs = new Map(), imports = new Map(), exports = new Map(), functions = [];
  for (const n of tree.body) {
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.type === 'Identifier') defs.set(d.id.name, d.init);
    if (n.type === 'FunctionDeclaration') { defs.set(n.id.name, n); functions.push(n); }
    if (n.type === 'ImportDeclaration') for (const x of n.specifiers) imports.set(x.local.name, n.source.value);
    if (n.type === 'ExportNamedDeclaration') for (const x of n.specifiers) exports.set(x.exported.name, x.local.name);
  }
  return { src, tree, defs, imports, exports, functions, text: n => src.slice(n.start, n.end) };
}
