// Offline, first-party Windows 1.1.0 research. No Electron registration or native acceptance.
import assert from 'node:assert/strict';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { types } from 'node:util';
import { find, moduleShape, name, only, prop, value } from './ast.mjs';
import { researchInput, sha, withCandidate } from './candidate.mjs';
import { inspectCandidateIpc } from './ipc.mjs';

const READ = 'readManyClientPersistence', WRITE = 'writeClientPersistence';
const layout = 'sand.client.slice.ui-layout';
const EDGE = 'dune-rpc:main:';
const UNKNOWN = 'edge/unknown-method', DENIED = 'edge/untrusted-sender';
const INVALID = 'edge/invalid-args', FAILED = 'edge/handler-failed';
const archiveIdentity = researchInput().identity;
const preloadDigest = '3204c8744260d6070dcffe2192b184bc6cdc9cb5d881d73e8b30c3517e91dac9';

// Absolute byte ranges in this exact ASAR, independently hashed without extracting files.
// main-core: method/probe replies. main-app: the top-frame trust rule, handlers and store.
// eager-app: the account-insensitive layout descriptor, key builder and renderer call sites.
const anchors = {
  replies: [7044061, 3137, '76a3c04762f6bf03fd61444b1e751c8dd1594d16c3869e01fb51c941c27c3e55'],
  trust: [5778444, 160, '7341dd0dbea806c307d55c5e4a2fb7ae02d8dfbc95f419ab4169d13022437af6'],
  handlers: [5821773, 316, '79bc8de39843edef244e5a713a9416f35e15a6bf7ea3d30e80209e8fd0404a07'],
  filter: [6098583, 133, '5ec225afd0852a69e128cdbaa2d8fc97fb8ce0afe3033986b9f212c46b828e23'],
  writer: [6101321, 133, '2f69ddcd35d42bb670268d36c414a261daf42be2f46871bd82a8004bf472301c'],
  reader: [6102728, 480, 'bfe38b05ff040431fdc1a2ef4cb220573c08d02516fe26d48d2e641302573f88'],
  layout: [49500404, 80, '2f8afcc657de33ed02ac0ebc59516c8ed758771cf7a4f81480571c4855bf40fb'],
  keyBuilder: [53173918, 718, 'afc191e5b397c11a27111f5e91e41bc14f701d56ca6eba4ad0dd0c1d3a3b38f6'],
  caller: [53580505, 97, '5e770e8b6e3c74a8b33add74c2d66602400fd4f5e4065aa4e17df9052eda208a'],
};

function checkAnchors(file) {
  const fd = openSync(file, 'r');
  try {
    assert.equal(fstatSync(fd).size, archiveIdentity.archiveBytes);
    const sources = {};
    for (const [label, [offset, length, digest]] of Object.entries(anchors)) {
      const bytes = Buffer.alloc(length);
      assert.equal(readSync(fd, bytes, 0, length, offset), length, 'short contract evidence read');
      assert.equal(sha(bytes), digest, `${label} evidence digest mismatch`);
      sources[label] = bytes;
    }
    return sources;
  } finally { closeSync(fd); }
}

function withSources(file, use) {
  return withCandidate(file, read => {
    const bytes = read('preload');
    assert.equal(sha(bytes), preloadDigest, 'contract preload digest mismatch');
    return use(bytes, checkAnchors(file));
  });
}

function inspectPeers(parts) {
  // Some ranges are object entries or class methods, not standalone programs. Wrappers are
  // only parser context; neither they nor the source spans are ever evaluated.
  const parse = (bytes, before = '', after = '') => moduleShape(Buffer.concat([Buffer.from(before), bytes, Buffer.from(after)]));
  const expr = (bytes, before, after) => parse(bytes, before, after).tree.body[0].expression;
  const one = (root, predicate, label) => only(find(root, predicate), label);
  const replies = parse(parts.replies);
  const codes = find(replies.tree, n => n.type === 'ObjectExpression' && prop(n, 'failure')?.type === 'ObjectExpression')
    .map(reply => {
      const ok = prop(reply, 'ok'), failure = prop(reply, 'failure');
      assert.equal(ok.operator, '!'); assert.equal(value(ok.argument), 1);
      assert.ok(prop(failure, 'detail'));
      return value(replies.defs.get(prop(failure, 'code').name));
    });
  for (const code of [UNKNOWN, DENIED, INVALID, FAILED]) assert.ok(codes.includes(code), `missing failure envelope: ${code}`);
  const diagnostic = only(replies.functions.filter(fn => find(fn, n => n.type === 'Property' && name(n) === 'code' &&
    value(replies.defs.get(n.value.name)) === UNKNOWN).length), 'unknown-method probe');
  const served = one(diagnostic, n => n.type === 'ConditionalExpression' && n.test.callee?.property?.name === 'has', 'probe membership');
  assert.equal(served.test.arguments[0].name, diagnostic.params[2].name);
  for (const flag of ['ok', 'value']) {
    assert.equal(prop(served.consequent, flag).operator, '!'); assert.equal(value(prop(served.consequent, flag).argument), 0);
  }
  assert.equal(value(replies.defs.get(prop(prop(served.alternate, 'failure'), 'code').name)), UNKNOWN);

  const family = expr(parts.handlers, '({', '})})').properties[0].argument;
  assert.equal(value(family.arguments[0]), 'appWindow');
  const trust = prop(parse(parts.trust).functions[0].body.body[0].argument, 'appWindow');
  assert.equal(value(prop(trust, 'kind')), 'require'); assert.equal(prop(trust, 'test').body.property.name, 'isAppWindowTopFrame');
  const handlers = family.arguments[1], rd = prop(handlers, READ), wr = prop(handlers, WRITE);
  for (const [fn, method] of [[rd, 'readMany'], [wr, 'write']]) {
    assert.equal(fn.body.callee.object.property.name, 'clientPersistence'); assert.equal(fn.body.callee.property.name, method);
  }
  assert.equal(rd.body.arguments[0].name, rd.params[0].name);
  assert.deepEqual(wr.body.arguments.map(a => a.name), ['key', 'value'].map(k => prop(wr.params[0], k).name));
  const storeMethod = bytes => parse(bytes, 'class Store {', '}').tree.body[0].body.body[0];
  const reader = storeMethod(parts.reader), writer = storeMethod(parts.writer);
  assert.equal(name(reader), 'readMany'); assert.equal(name(writer), 'write');
  one(reader, n => n.type === 'ReturnStatement' && n.argument?.callee?.object?.name === 'Object' &&
    n.argument.callee.property.name === 'fromEntries', 'readMany record result');
  const runWrite = one(writer, n => n.type === 'ReturnStatement' && n.argument?.callee?.property?.name === 'run', 'write completion');
  const body = runWrite.argument.arguments[0]; assert.equal(body.async, true);
  one(body, n => n.type === 'AwaitExpression' && n.argument.callee?.property?.name === 'writeBlob', 'awaited write');
  assert.equal(find(body, n => n.type === 'ReturnStatement').length, 0, 'write has no success payload');
  const filter = parse(parts.filter).functions[0], [, bindings] = filter.body.body[0].declarations;
  const tie = filter.body.body.at(-1).argument;
  assert.equal(bindings.init.arguments[0].property.name, 'include');
  assert.equal(tie.operator, '&&'); assert.equal(tie.left.operator, '>='); assert.equal(value(tie.left.right), 0);
  assert.equal(tie.right.operator, '>='); assert.equal(tie.left.left.name, bindings.id.name); assert.equal(tie.right.left.name, bindings.id.name);
  assert.equal(tie.right.right.callee.name, bindings.init.callee.name); assert.equal(tie.right.right.arguments[0].property.name, 'exclude');
  const caller = expr(parts.caller, '({', '})'), read = prop(caller, 'readMany'), write = prop(caller, 'write');
  assert.equal(read.body.callee.property.name, READ); assert.equal(read.body.arguments[0].name, read.params[0].name);
  assert.equal(write.body.callee.property.name, WRITE);
  assert.deepEqual(['key', 'value'].map(k => prop(write.body.arguments[0], k).name), write.params.map(p => p.name));

  const desc = expr(parts.layout, '(', ')'), sensitive = prop(desc, 'accountSensitive');
  assert.equal(value(prop(desc, 'scope')), 'client-persisted'); assert.equal(sensitive.operator, '!'); assert.equal(value(sensitive.argument), 1);
  const keys = parse(parts.keyBuilder), branch = one(keys.tree, n => n.type === 'ConditionalExpression' &&
    n.test.property?.name === 'accountSensitive', 'key builder');
  const template = branch.alternate.expressions.at(-1);
  assert.equal(template.type, 'TemplateLiteral'); assert.deepEqual(template.quasis.map(q => q.value.cooked), ['', '', '']);
  assert.equal(template.expressions[1].object.name, branch.test.object.name); assert.equal(template.expressions[1].property.name, 'slice');
  assert.equal(value(keys.defs.get(template.expressions[0].name)) + value(prop(desc, 'slice')), layout);
}

// Maintainer verification (node --expose-internals); no caller-supplied declaration or digest.
export function inspectPersistenceContract(file) {
  return withSources(file, (bytes, parts) => {
    const ipc = inspectCandidateIpc(bytes), m = moduleShape(bytes, 'commonjs');
    const fields = (method, keys) => {
      assert.deepEqual(ipc.selectedArgumentFields[method], keys);
      const entry = only(find(m.tree, n => n.type === 'Property' && name(n) === method), method);
      assert.equal(entry.value.callee.property.name, 'args');
      return keys.map(key => prop(entry.value.arguments[0], key));
    };
    const [include, exclude] = fields(READ, ['include', 'exclude']);
    const [key, val] = fields(WRITE, ['key', 'value']);
    assert.equal(include.callee.name, exclude.callee.name);
    for (const scalar of [key, val, include.arguments[0], exclude.arguments[0]]) {
      assert.equal(scalar.type, 'CallExpression'); assert.equal(scalar.callee.name, key.callee.name);
      assert.equal(scalar.arguments.length, 0);
    }
    const strings = m.defs.get(key.callee.name), array = m.defs.get(include.callee.name);
    only(find(strings, n => n.type === 'BinaryExpression' && n.left.operator === 'typeof' &&
      value(n.right) === 'string'), 'string validator');
    only(find(array, n => n.type === 'CallExpression' && n.callee.object?.name === 'Array' &&
      n.callee.property?.name === 'isArray'), 'array validator');
    only(find(array, n => n.type === 'CallExpression' && n.callee.object?.name === array.params[0].name &&
      n.callee.property?.name === 'check'), 'array element validator');
    inspectPeers(parts);
    return { version: archiveIdentity.version, headerSha256: archiveIdentity.headerSha256, preloadSha256: preloadDigest,
      fixedRegistrarMatches: ipc.fixedRegistrarMatches, methods: [READ, WRITE], key: layout, nativeVerified: false };
  });
}

// Binding uses those same byte pins without requiring Node's internal AST parser at runtime.
export function bindPersistenceContract(file, capabilities) {
  return withSources(file, () => {
    const local = createLocalLayoutPersistence(capabilities);
    const channels = Object.freeze({ __proto__: null,
      [`${EDGE}probe`]: local.probe, [`${EDGE}m:${READ}`]: local.readMany, [`${EDGE}m:${WRITE}`]: local.write,
    });
    return Object.freeze({ channels, revoke: local.revoke });
  });
}

// Deliberately smaller than the vendor store. These are local ceilings, not vendor quotas.
const maxPrefixes = 64, maxPrefixLength = 256, maxLayoutBytes = 64 * 1024;
const failure = (code, detail) => ({ ok: false, failure: { code, detail } });
const denied = () => failure(DENIED, 'Local layout capability is not active for this sender.');
const invalid = () => failure(INVALID, 'Arguments are outside the local layout contract.');
const failed = () => failure(FAILED, 'Local layout persistence failed.');
const success = value => ({ ok: true, value });
const record = obj => obj !== null && typeof obj === 'object' && !types.isProxy(obj) &&
  (Object.getPrototypeOf(obj) === Object.prototype || Object.getPrototypeOf(obj) === null);
const data = (obj, key) => {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d?.enumerable && Object.hasOwn(d, 'value') ? d.value : undefined;
};
const pair = (obj, a, b) => record(obj) && Reflect.ownKeys(obj).length === 2 && Object.hasOwn(obj, a) && Object.hasOwn(obj, b);
const layoutText = v => typeof v === 'string' && v.length <= maxLayoutBytes && Buffer.byteLength(v) <= maxLayoutBytes;

function longest(list) {
  if (types.isProxy(list) || !Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype ||
      list.length > maxPrefixes || Reflect.ownKeys(list).length !== list.length + 1) return null;
  let best = -1;
  for (let i = 0; i < list.length; ++i) {
    const prefix = data(list, i);
    if (typeof prefix !== 'string' || prefix.length > maxPrefixLength) return null;
    if (layout.startsWith(prefix)) best = Math.max(best, prefix.length);
  }
  return best;
}

// Typed first-party policy; only bindPersistenceContract exposes named wire channels.
// Capture the project's window and main-frame identities. Replacing either requires a new
// adapter. Revocation hides late replies; it cannot undo an already dispatched write.
export function createLocalLayoutPersistence({ window, readMany, write }) {
  if (typeof window?.isDestroyed !== 'function' || window.isDestroyed() !== false ||
      typeof readMany !== 'function' || typeof write !== 'function')
    throw new TypeError('A live owner window and both local persistence capabilities are required');
  const owner = window.webContents, frame = owner?.mainFrame;
  if (!owner || typeof owner !== 'object' || !frame || typeof frame !== 'object')
    throw new TypeError('A live owner main frame is required');
  let revoked = false;
  function allowed(event) {
    if (revoked) return false;
    try {
      if (window.isDestroyed() !== false || window.webContents !== owner || owner.mainFrame !== frame) revoked = true;
    } catch { revoked = true; }
    if (revoked) return false;
    try { return event?.sender === owner && event.senderFrame === frame && !revoked; } catch { return false; }
  }
  function probe(event, method) {
    if (!allowed(event)) return denied(); // Stricter than the stock diagnostic probe.
    if (typeof method !== 'string') return invalid();
    return method === READ || method === WRITE ? success(true) : failure(UNKNOWN, 'No such local layout method.');
  }
  async function read(event, args) {
    if (!allowed(event)) return denied();
    if (!pair(args, 'include', 'exclude')) return invalid();
    const include = longest(data(args, 'include')), exclude = longest(data(args, 'exclude'));
    if (include === null || exclude === null) return invalid();
    if (include < 0 || include < exclude) return success({});
    try {
      // The shared handler does prefix reads. Never pass the caller's broad filter through,
      // and never return prefix siblings, even when the backend includes them in its reply.
      const result = await readMany({ include: [layout], exclude: [] });
      if (!allowed(event)) return denied();
      if (!record(result)) return failed();
      if (!Object.hasOwn(result, layout)) return success({});
      const text = data(result, layout);
      return layoutText(text) ? success({ [layout]: text }) : failed();
    } catch { return allowed(event) ? failed() : denied(); }
  }
  async function store(event, args) {
    if (!allowed(event)) return denied();
    if (!pair(args, 'key', 'value')) return invalid();
    const key = data(args, 'key'), text = data(args, 'value');
    if (key !== layout || !layoutText(text)) return invalid();
    try {
      const result = await write({ key: layout, value: text });
      if (!allowed(event)) return denied();
      return result === undefined ? success(undefined) : failed();
    } catch { return allowed(event) ? failed() : denied(); }
  }
  return Object.freeze({ __proto__: null, probe, readMany: read, write: store, revoke: () => { revoked = true; } });
}
