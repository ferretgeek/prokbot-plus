// Research only. Never import the input or use these observations to register IPC handlers.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const channels = new Map([
  ['sand:boot-snapshot-sync', 'sendSync'], ['sand:coordinator-port-request', 'invoke'],
  ['sand:coordinator-port', 'on'], ['dune-rpc:main:probe', 'invoke'],
]);
const ipcMembers = new Set(['on', 'once', 'invoke', 'send', 'sendSync', 'postMessage', 'removeListener', 'off']);
const knownPhases = new Set(['hello', 'ready']);
const require = createRequire(import.meta.url);
const literal = node => node?.type === 'Literal' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
const key = prop => (!prop.computed && prop.key?.type === 'Identifier') ? prop.key.name : literal(prop.key);
const member = node => node.type === 'MemberExpression' ? (!node.computed ? node.property.name : literal(node.property)) : undefined;

function* nodes(root) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    yield node;
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) { for (const item of child) if (item?.type) pending.push(item); }
      else if (child?.type) pending.push(child);
    }
  }
}

export function inspectPreload(bytes, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) throw new Error('A full independently recorded preload SHA-256 is required');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.toLowerCase()) throw new Error('Preload SHA-256 mismatch; input not parsed');
  let parse;
  try { ({ parse } = require('internal/deps/acorn/acorn/dist/acorn')); }
  catch { throw new Error('Run this offline research tool with node --expose-internals'); }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', allowHashBang: true, allowReturnOutsideFunction: true });
  const calls = new Map([...channels.keys()].map(name => [name, new Set()]));
  const lifecycle = [], versions = new Set();
  for (const node of nodes(tree)) {
    if (node.type === 'CallExpression') {
      const api = member(node.callee), channel = literal(node.arguments[0]);
      if (ipcMembers.has(api) && calls.has(channel)) calls.get(channel).add(api);
    }
    if (node.type !== 'ObjectExpression') continue;
    const props = new Map(node.properties.map(p => [key(p), literal(p.value)]));
    if (Number.isSafeInteger(props.get('protocolVersion'))) versions.add(props.get('protocolVersion'));
    if (props.get('kind') === 'lifecycle' && knownPhases.has(props.get('phase'))) {
      const version = props.get('protocolVersion');
      lifecycle.push({ phase: props.get('phase'), literalVersion: Number.isSafeInteger(version) ? version : null });
    }
  }
  // This intentionally mirrors the fixed client's spelling-dependent registration, not upstream semantics.
  const legacyMethodCount = new Set([...source.matchAll(/([A-Za-z_$][\w$]*):t\(\)\.(?:args|noArgs)/g)].map(m => m[1])).size;
  return { evidence: 'static call shapes only', nativeVerified: false, sha256, bytes: bytes.length, legacyMethodCount,
    channels: Object.fromEntries([...channels].map(([name, expectedMember]) => [name,
      { expectedMember, observedMembers: [...calls.get(name)].sort() }])),
    lifecycle, literalProtocolVersions: [...versions].sort((a, b) => a - b) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [input, digest, ...extra] = process.argv.slice(2);
    if (!input || !digest || extra.length || !/^[a-f0-9]{64}$/i.test(digest))
      throw new Error('Usage: node --expose-internals inspect-desktop-preload.mjs <handed-off preload> <expected SHA-256>');
    console.log(JSON.stringify(inspectPreload(readFileSync(input), digest), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
