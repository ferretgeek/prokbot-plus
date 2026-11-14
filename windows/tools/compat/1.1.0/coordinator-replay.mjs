// Offline acceptance evidence, not a port implementation. Writes JSON to stdout only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { calls, find, name, only, prop, value } from './ast.mjs';
import { researchInput, sha } from './candidate.mjs';
import { Pickle } from '../../../../mac/patchers/desktop/node_modules/@electron/asar/lib/pickle.js';

const identity = researchInput('windows').identity;
const members = {
  app: ['dist/renderer/assets/index.eager-app-BwKPFs1J.js', 5332700, '674d104b22e65cd64f9b20534c561aa3ee804f5c7a7ac1f95a95fb1dc6ca4d24'],
  common: ['dist/renderer/assets/index.eager-common-DcDxc78C.js', 415503, '20df573a0e52713e85620b6ad7b588bdf7939a3f8c78b0ca791d0bb85ac464b3'],
};

function authenticatedMembers(file) {
  // Reject UNC/device names and URI inputs before asking the filesystem to open anything.
  if (typeof file !== 'string' || !file || /^(?:[\\/]{2}|[a-z][a-z\d+.-]*:\/\/)/i.test(file))
    throw new Error('A local Windows 1.1.0 ASAR file is required');
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size === identity.archiveBytes, 'unexpected Windows ASAR size or file type');
    function fill(buffer, start, length = buffer.length) {
      let done = 0;
      while (done < length) {
        const n = readSync(fd, buffer, done, length - done, start + done);
        assert.ok(n > 0, 'short ASAR read'); done += n;
      }
      return buffer;
    }
    const envelope = fill(Buffer.alloc(8), 0);
    assert.equal(envelope.readUInt32LE(0), 4, 'invalid ASAR size pickle');
    assert.equal(envelope.readUInt32LE(4), identity.headerBytes, 'unexpected Windows ASAR header size');
    const packed = fill(Buffer.alloc(identity.headerBytes), 8);
    const headerText = Pickle.createFromBuffer(packed).createIterator().readString();
    assert.equal(sha(headerText), identity.headerSha256, 'Windows ASAR header digest mismatch');
    const header = JSON.parse(headerText), result = {};
    for (const [role, [member, size, digest]] of Object.entries(members)) {
      const info = member.split('/').reduce((entry, part) => entry?.files?.[part], header);
      assert.ok(info && !info.files && !info.link && !info.unpacked, 'expected a packed renderer member');
      assert.equal(info.integrity?.algorithm, 'SHA256'); assert.equal(info.integrity.hash, digest);
      assert.equal(info.size, size); assert.match(info.offset, /^\d+$/);
      const start = 8 + identity.headerBytes + Number(info.offset);
      assert.ok(Number.isSafeInteger(start) && start + size <= stat.size, 'invalid packed member extent');
      const bytes = fill(Buffer.alloc(size), start);
      assert.equal(sha(bytes), digest, `${role} member digest mismatch`);
      result[role] = bytes;
    }
    // Bind even the uninspected archive bytes, without loading or parsing other members.
    const chunk = Buffer.alloc(256 * 1024), hash = createHash('sha256');
    hash.update(envelope).update(packed);
    for (let pos = 8 + packed.length; pos < stat.size; pos += chunk.length) {
      const n = Math.min(chunk.length, stat.size - pos);
      hash.update(fill(chunk, pos, n).subarray(0, n));
    }
    assert.equal(hash.digest('hex'), identity.archiveSha256, 'Windows ASAR archive digest mismatch');
    return result;
  } finally { closeSync(fd); }
}

// Member-relative byte ranges. The largest parser input is the 7,398-byte table, not the bundle.
const declarations = {
  F9: [5228081, 79], I9: [5228160, 43], L9: [5228203, 53], aqr: [5228256, 79],
  oqr: [5228335, 1162], sqr: [5229497, 845], cqr: [5230342, 877],
  lqr: [5231219, 93], uqr: [5231312, 97], nte: [207907, 199], ste: [208865, 592],
  ote: [208804, 61], rte: [208152, 493], JLt: [2058440, 786], KLt: [2058223, 175],
  bqr: [5236840, 3180], Tqr: [5241896, 1151], lm: [341572, 72], vqr: [5235783, 916],
  pm: [342064, 68], hm: [342338, 159], mm: [342268, 70], mqr: [5233563, 148],
};
const pureIds = ['F9', 'I9', 'L9', 'aqr', 'oqr', 'sqr', 'cqr', 'lqr', 'uqr', 'nte', 'ste', 'ote', 'rte', 'JLt', 'KLt', 'Et', 'Dt'];
const methods = ['listAgents', 'getAgentTranscriptTail', 'sendPrompt'];
const pureDigest = '5b74f9bc2c7589632bd21338fefb0f0590e18bfd190d9df5fb4e82d9a2921528';
const expressionDigest = '5fd81df0ee3fbbad43ffaa0522c5b104e49e6cb1e36da0f0e2d80fcdda6c5cd0';
const pendingGuardsDigest = '97917cf5fd4d714e95cd3c63b79a59e982a194823c8d0b0fe1c01e27da9eaf35';

function selections(bytes) {
  let acorn;
  try { acorn = createRequire(import.meta.url)('internal/deps/acorn/acorn/dist/acorn'); }
  catch { throw new Error('Run the offline verifier with node --expose-internals'); }
  const options = { ecmaVersion: 2024, sourceType: 'module' }, ranges = {}, nodes = {};
  function span(role, id, start, length, type) {
    const slab = bytes[role].subarray(start, start + length);
    assert.ok(length <= 7398 && slab.length === length, 'invalid parser span');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(slab);
    assert.equal(text.length, length, 'selected offsets must be ASCII byte offsets');
    // A bounded export list has no declarations in scope; parse only its specifiers.
    const ast = type === 'ExportNamedDeclaration'
      ? only(acorn.parse(text, { ...options, sourceType: 'script', allowImportExportEverywhere: true }).body, id)
      : type === 'ImportDeclaration' ? only(acorn.parse(text, options).body, id)
        : acorn.parseExpressionAt(text, 0, options);
    assert.equal(ast.type, type, id); assert.equal(ast.start, 0, id); assert.equal(ast.end, length, id);
    if (type === 'FunctionExpression') assert.equal(ast.id.name, id);
    ranges[id] = { member: role, start, bytes: length, sha256: sha(slab) };
    nodes[id] = ast;
    return ast;
  }
  for (const [id, range] of Object.entries(declarations)) span('app', id, ...range, 'FunctionExpression');
  span('common', 'Et', 200499, 65, 'FunctionExpression'); span('common', 'Dt', 200564, 71, 'FunctionExpression');
  const imports = span('app', 'guardImports', 14157, 948, 'ImportDeclaration');
  const exports = span('common', 'guardExports', 414352, 1101, 'ExportNamedDeclaration');
  assert.equal(path.posix.join(path.posix.dirname(members.app[0]), imports.source.value), members.common[0]);
  for (const [local, declaration] of [['Mi', 'Et'], ['ii', 'Dt']]) {
    const imported = only(imports.specifiers.filter(s => s.local.name === local), local).imported.name;
    assert.equal(only(exports.specifiers.filter(s => s.exported.name === imported), imported).local.name, declaration);
  }
  function initializer(id, start, size, type) {
    const prefix = `${id}=`;
    assert.equal(bytes.app.toString('ascii', start - prefix.length, start), prefix, `initializer of ${id}`);
    return span('app', id, start, size, type);
  }
  const cm = initializer('cm', 333678, 7398, 'ObjectExpression');
  const fqr = initializer('fqr', 5231548, 1876, 'ObjectExpression');
  const limit = initializer('ate', 208800, 3, 'Literal'); assert.equal(value(limit), 400);
  const sentinel = initializer('R9', 5231416, 25, 'CallExpression'); assert.equal(sentinel.callee.name, 'Symbol');
  const table = Object.fromEntries(methods.map(k => {
    const descriptor = only(cm.properties.filter(p => name(p) === k), k).value;
    return [k, { args: value(prop(descriptor, 'args')), reply: value(prop(descriptor, 'reply')) }];
  }));
  assert.equal(cm.properties.length, 144); assert.equal(prop(cm, 'abort'), undefined);
  assert.deepEqual(methods.map(k => Object.values(table[k])), [['none', 'array'], ['object', 'transcript-page'], ['object', 'send-result']]);
  const text = (id, node = nodes[id]) => {
    const range = ranges[id]; return bytes[range.member].toString('utf8', range.start + node.start, range.start + node.end);
  };
  const guards = methods.map(k => {
    const n = only(fqr.properties.filter(p => name(p) === table[k].reply), table[k].reply).value;
    assert.equal(n.type, 'ArrowFunctionExpression'); return text('fqr', n);
  });
  const defs = pureIds.map(id => text(id));
  assert.equal(sha([...defs, ...guards].join('\0')), pureDigest, 'isolated parser/guard allowlist mismatch');
  const failureCodes = {};
  for (const [fn, id, start, length] of [['pm', 'um', 341651, 18], ['hm', 'fm', 341737, 26], ['mm', 'gme', 341709, 24]]) {
    const result = nodes[fn].body.body[0].argument;
    assert.equal(result.type, 'NewExpression'); assert.equal(prop(result.arguments[0], 'code').name, id);
    failureCodes[fn] = value(initializer(id, start, length, 'TemplateLiteral'));
  }
  return { nodes, ranges, table, text, defs, guards, failureCodes };
}

const oneCall = (n, id) => only(calls(n, id), id);
const memberCalls = (n, key) => find(n, v => v.type === 'CallExpression' && v.callee.property?.name === key);
const apiCall = (n, key) => only(memberCalls(n, key), key);
const variable = (fn, id) => only(fn.body.body.flatMap(n => n.declarations ?? []).filter(d => d.id.name === id), id).init;
const fields = obj => obj.properties.map(name);

function senderEvidence({ nodes: n, text, failureCodes }) {
  const sender = n.bqr, session = sender.body.body.at(-1).argument;
  const binding = oneCall(n.Tqr, 'bqr').arguments[0], forward = prop(binding, 'post');
  assert.equal(forward.body.callee.property.name, 'postMessage');
  assert.equal(forward.body.arguments[0].name, forward.params[0].name);
  const port = forward.body.callee.object.name;
  assert.equal(prop(binding, 'close').body.callee.object.name, port);
  assert.equal(prop(binding, 'close').body.callee.property.name, 'close');
  const wired = only(find(n.Tqr, d => d.type === 'VariableDeclarator' && d.init?.callee?.name === 'bqr'), 'session binding').id.name;
  const listeners = memberCalls(n.Tqr, 'addEventListener');
  for (const [event, method] of [['message', 'handleMessage'], ['close', 'handlePortClosed']]) {
    const on = only(listeners.filter(c => value(c.arguments[0]) === event), event);
    assert.equal(on.callee.object.name, port);
    const callback = on.arguments[1], call = apiCall(callback, method);
    assert.equal(call.callee.object.name, wired);
    if (event === 'message') {
      assert.equal(call.arguments[0].object.name, callback.params[0].name); assert.equal(call.arguments[0].property.name, 'data');
    }
  }
  const helloCall = only(sender.body.body.map(v => v.expression).filter(v => v?.callee?.property?.name === 'post'), 'unconditional hello');
  const post = call => {
    assert.equal(call.callee.object.name, sender.params[0].name); assert.equal(call.arguments.length, 1);
    const obj = call.arguments[0]; assert.equal(obj.type, 'ObjectExpression'); return obj;
  };
  const hello = post(helloCall), version = value(prop(hello, 'protocolVersion'));
  assert.deepEqual(fields(hello), ['kind', 'phase', 'protocolVersion']);
  assert.deepEqual(hello.properties.map(p => value(p.value)), ['lifecycle', 'hello', 3]);

  const message = prop(session, 'handleMessage'), parsed = oneCall(message, 'oqr');
  assert.equal(parsed.arguments[0].name, message.params[0].name);
  const dispatch = message.body.body.at(-1).expression;
  assert.equal(dispatch.test.property.name, 'accepted'); assert.equal(dispatch.consequent.arguments[0].property.name, 'frame');
  assert.equal(dispatch.alternate.arguments[0].object.property.name, 'rejection'); assert.equal(dispatch.alternate.arguments[0].property.name, 'detail');
  const breachId = dispatch.alternate.callee.name, breach = variable(sender, breachId);
  const route = variable(sender, dispatch.consequent.callee.name).body.body[0];
  for (const [branch, phase] of [[route, 'shutdown'], [route.alternate, 'ready']]) {
    assert.equal(branch.test.operator, '&&');
    assert.deepEqual([branch.test.left, branch.test.right].map(b => [b.left.property.name, b.operator, value(b.right)]),
      [['kind', '===', 'lifecycle'], ['phase', '===', phase]]);
  }
  const [repeat, mismatch, live] = route.alternate.consequent.body;
  const before = value(variable(sender, repeat.test.left.name)), serving = value(live.expression.expressions[0].right);
  assert.equal(repeat.test.operator, '!=='); assert.equal(value(repeat.test.right), before); assert.equal(before, 'awaiting-ready');
  assert.equal(mismatch.test.left.property.name, 'protocolVersion'); assert.equal(mismatch.test.operator, '!==');
  assert.equal(value(mismatch.test.right), version); assert.equal(live.expression.expressions[0].left.name, repeat.test.left.name);
  assert.equal(serving, 'serving');
  const detail = branch => {
    assert.equal(branch.consequent.body.at(-1).type, 'ReturnStatement');
    return oneCall(branch.consequent, breachId).arguments[0];
  };
  const repeatDetail = detail(repeat), versionDetail = detail(mismatch), protocolShutdown = post(apiCall(breach, 'post'));
  const settledBy = prop(session, 'handlePortClosed').body.body[0].expression.callee.name;
  const settle = variable(sender, settledBy).body.body[0], settled = value(settle.test.right);
  assert.equal(settled, 'settled'); assert.equal(settle.test.left.name, repeat.test.left.name); assert.equal(settle.test.operator, '!==');
  const afterClose = message.body.body[0];
  assert.equal(afterClose.test.left.name, repeat.test.left.name); assert.equal(afterClose.test.operator, '===');
  assert.equal(value(afterClose.test.right), settled); assert.equal(afterClose.consequent.type, 'ReturnStatement');
  assert.equal(value(settle.consequent.body[0].expression.expressions[0].right), settled);
  const closed = apiCall(settle, 'close'); assert.equal(closed.callee.object.name, sender.params[0].name);
  const down = only(memberCalls(settle, 'listener').filter(c => value(c.arguments[0]) === 'down'), 'settlement notification');
  const cleanup = settle.consequent.body.find(s => s.type === 'ForOfStatement' && s.right.callee?.property?.name === 'values');
  assert.ok(cleanup); apiCall(cleanup, 'detachAbort'); assert.equal(apiCall(cleanup, 'reject').arguments[0].callee.name, 'hm');
  assert.equal(apiCall(settle, 'clear').callee.object.name, cleanup.right.callee.object.name);
  assert.equal(memberCalls(settle, 'post').length, 0); assert.equal(memberCalls(prop(session, 'handlePortClosed'), 'post').length, 0);
  for (const v of [route.consequent, breach, prop(session, 'dispose')]) oneCall(v, settledBy);
  const requestedShutdown = post(apiCall(prop(session, 'dispose'), 'post'));
  assert.equal(value(prop(protocolShutdown, 'reason')), 'protocol-error'); assert.equal(value(prop(requestedShutdown, 'reason')), 'requested');

  const makeMethods = oneCall(prop(session, 'source'), 'lm').arguments[0];
  assert.equal(apiCall(n.lm, 'keys').arguments[0].name, 'cm');
  const lookup = makeMethods.body.body[0].declarations[0];
  assert.equal(lookup.init.object.name, 'cm'); assert.equal(lookup.init.property.name, makeMethods.params[0].name);
  const wrapper = makeMethods.body.body.at(-1).argument, choose = wrapper.body;
  assert.equal(choose.test.left.object.name, lookup.id.name); assert.equal(choose.test.left.property.name, 'args');
  assert.equal(value(choose.test.right), 'none'); assert.deepEqual(fields(choose.consequent.arguments[1]), []);
  assert.equal(choose.alternate.arguments[1].operator, '??'); assert.equal(choose.alternate.arguments[1].left.name, wrapper.params[0].name);
  for (const c of [choose.consequent, choose.alternate]) {
    assert.equal(c.callee.name, choose.consequent.callee.name); assert.equal(c.arguments[0].name, makeMethods.params[0].name);
    assert.equal(c.arguments[2].object.name, lookup.id.name); assert.equal(c.arguments[2].property.name, 'reply');
  }
  const send = variable(sender, choose.consequent.callee.name), posts = memberCalls(send, 'post').map(post);
  const byKind = kind => only(posts.filter(o => value(prop(o, 'kind')) === kind), kind);
  const request = byKind('request'), cancel = byKind('cancel');
  assert.equal(prop(request, 'method').name, send.params[0].name); assert.equal(prop(request, 'args').name, send.params[1].name);
  assert.equal(prop(cancel, 'requestId').name, prop(request, 'requestId').name);
  const requestId = variable(send, prop(request, 'requestId').name);
  const counter = only(requestId.expressions, 'request number').name;
  assert.equal(value(variable(sender, counter)), 0);
  const increment = only(find(send, d => d.type === 'AssignmentExpression' && d.left.name === counter), 'request increment');
  assert.equal(increment.operator, '+='); assert.equal(value(increment.right), 1);
  const replyGuard = only(find(send, x => x.type === 'CallExpression' && x.callee.object?.name === 'fqr'), 'reply guard lookup');
  assert.equal(replyGuard.callee.property.name, send.params[2].name); assert.equal(replyGuard.arguments[0].callee.name, 'mqr');
  const normalizer = n.mqr.body.body[0]; assert.equal(normalizer.discriminant.name, n.mqr.params[0].name);
  assert.ok(!normalizer.cases.some(c => methods.includes(value(c.test))));
  assert.equal(normalizer.cases.at(-1).test, null); assert.equal(normalizer.cases.at(-1).consequent[0].argument.name, n.mqr.params[1].name);

  const preAbort = send.body.body[0]; assert.equal(apiCall(preAbort.consequent, 'reject').arguments[0].callee.name, 'pm');
  const listen = apiCall(send, 'addEventListener'), detach = apiCall(send, 'removeEventListener');
  assert.deepEqual([listen, detach].map(c => value(c.arguments[0])), ['abort', 'abort']);
  assert.equal(listen.arguments[1].name, detach.arguments[1].name);
  const once = prop(listen.arguments[2], 'once'); assert.equal(once.operator, '!'); assert.equal(value(once.argument), 0);
  const promise = only(find(send, d => d.type === 'NewExpression' && d.callee.name === 'Promise'), 'pending reply promise');
  const executor = only(promise.arguments, 'pending reply executor');
  assert.equal(apiCall(executor, 'addEventListener'), listen);
  const onAbort = variable(executor, listen.arguments[1].name);
  assert.equal(onAbort.type, 'ArrowFunctionExpression');
  assert.equal(post(apiCall(onAbort, 'post')), cancel);
  const pending = apiCall(onAbort, 'has'); assert.equal(pending.arguments[0].name, prop(cancel, 'requestId').name);
  assert.equal(pending.callee.object.name, cleanup.right.callee.object.name);
  const gate = onAbort.body.body[0].expression;
  assert.equal(gate.operator, '&&'); assert.equal(gate.left.operator, '&&'); assert.equal(gate.left.right, pending);
  assert.equal(gate.left.left.operator, '!=='); assert.equal(value(gate.left.left.right), settled); assert.equal(post(gate.right), cancel);
  const [replyRoute, eventRoute] = [route.alternate.alternate.expression, route.alternate.alternate.expression.alternate];
  assert.equal(value(replyRoute.test.right), 'reply'); assert.equal(value(eventRoute.test.right), 'event');
  assert.deepEqual(replyRoute.consequent.arguments.map(a => a.property.name), ['requestId', 'outcome']);
  assert.deepEqual(eventRoute.consequent.arguments.map(a => a.property.name), ['family', 'payload']);
  const reply = variable(sender, replyRoute.consequent.callee.name);
  assert.equal(apiCall(reply, 'delete').callee.object.name, pending.callee.object.name); apiCall(reply, 'detachAbort');
  assert.equal(oneCall(reply, 'vqr').arguments[1].property.name, 'failure');
  const cancelled = n.vqr.body.body[0]; assert.equal(cancelled.test.left.property.name, 'code');
  assert.equal(value(cancelled.test.right), 'cancelled'); assert.equal(cancelled.consequent.argument.callee.name, 'pm');
  const state = variable(sender, eventRoute.consequent.callee.name).body.body[0];
  const families = [state, state.alternate].map(branch => value(branch.test.right));
  assert.deepEqual(families, ['coordinator-transport-state', 'coordinator-transcript-source']);
  const eventCodes = {};
  for (const [branch, id, field] of [[state, 'lqr', 'state'], [state.alternate, 'uqr', 'source']]) {
    oneCall(branch.consequent, id); assert.equal(apiCall(branch.consequent, 'listener').arguments[0].property.name, field);
    assert.equal(branch.consequent.body[1].consequent.type, 'ReturnStatement');
    const decoded = n[id].body.body[0].argument, param = n[id].params[0].name;
    assert.equal(decoded.type, 'ConditionalExpression'); assert.equal(value(decoded.alternate), null);
    assert.deepEqual(fields(decoded.consequent), [field]); assert.equal(prop(decoded.consequent, field).property.name, field);
    assert.equal(decoded.test.operator, '&&'); assert.equal(decoded.test.left.callee.name, 'Mi');
    assert.equal(decoded.test.left.arguments[0].name, param);
    const options = decoded.test.right; assert.equal(options.operator, '||');
    eventCodes[field] = [options.left, options.right].map(b => {
      assert.equal(b.operator, '==='); assert.equal(b.left.object.name, param); assert.equal(b.left.property.name, field);
      return value(b.right);
    });
  }
  assert.deepEqual(n.oqr.body.body[1].cases.map(c => value(c.test) ?? null), ['lifecycle', 'request', 'cancel', 'reply', 'event', null]);

  // Only these reviewed data expressions, never bqr/Tqr or their effectful closures, enter the VM.
  const expressions = { protocolShutdown, hello, cancel, request, requestedShutdown, requestId,
    repeated: repeat.test, repeatDetail, incompatible: mismatch.test, versionDetail, preAborted: preAbort.test, notSettled: settle.test };
  const fragments = Object.fromEntries(Object.entries(expressions).map(([k, v]) => [k, text('bqr', v)]));
  assert.equal(sha(Object.values(fragments).join('\0')), expressionDigest, 'sender expression allowlist mismatch');
  const pendingGuards = { canCancel: text('bqr', gate.left), ignoreMessage: text('bqr', afterClose.test) };
  assert.equal(sha(Object.values(pendingGuards).join('\0')), pendingGuardsDigest, 'pending guard allowlist mismatch');
  Object.assign(fragments, pendingGuards);
  return { fragments, contract: { sender: 'Tqr -> bqr -> port.postMessage', protocolVersion: version,
    phases: { before, serving, settled }, families, eventCodes, frameKinds: n.oqr.body.body[1].cases.filter(c => c.test).map(c => value(c.test)),
    abort: { kind: value(prop(cancel, 'kind')), rpcMethod: false, failureCode: failureCodes.pm },
    close: { pendingFailureCode: failureCodes.hm, notifies: value(down.arguments[0]), clearsPending: true, detachesAbort: true },
    malformedReplyCode: failureCodes.mm } };
}

function pureRealm(selection, fragments) {
  const { nodes, defs, guards } = selection;
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  const run = script => script.runInContext(context, { timeout: 250, displayErrors: false });
  const guardTable = methods.map((method, i) => `${JSON.stringify(method)}:(${guards[i]})`).join(',');
  // The parameters below are fixture bindings for the fingerprinted expressions, not host objects.
  const params = { protocolShutdown: 'n', hello: '', cancel: 'l', request: 'l,i,a,c', requestedShutdown: '',
    requestId: 'n', repeated: 't', repeatDetail: '', incompatible: 'e', versionDetail: 'e', preAborted: 's', notSettled: 't',
    canCancel: 't,r,l', ignoreMessage: 't' };
  const exprFns = Object.entries(fragments).map(([k, expr]) => `${k}:(${params[k]})=>(${expr})`);
  run(new vm.Script(`"use strict";\n${defs.join('\n')}\nconst Mi=Et,ii=Dt,ate=${value(nodes.ate)},R9=Symbol();
    const guards={${guardTable}}, functions={${exprFns.join(',')},parse:oqr,state:lqr,source:uqr,
      abortPermitted:(phase,ids,id)=>functions.canCancel(phase,new Set(ids),id),
      container:(method,input)=>{const v=guards[method](input);return v===R9?{valid:false}:
        v===undefined?{valid:true,valueKind:'undefined'}:{valid:true,value:v}}};`, { filename: 'isolated-renderer' }));
  const scripts = new Map();
  return (op, ...args) => {
    if (!scripts.has(op)) {
      assert.ok(Object.hasOwn(params, op) || ['parse', 'state', 'source', 'container', 'abortPermitted'].includes(op));
      scripts.set(op, new vm.Script(`JSON.stringify(functions.${op}(...JSON.parse(fixture)))`, { filename: 'synthetic-input' }));
    }
    context.fixture = JSON.stringify(args);
    assert.ok(context.fixture.length <= 4096, 'fixture size limit');
    return JSON.parse(run(scripts.get(op))); // Only a serialized primitive crosses the realm boundary.
  };
}

function transcript(run, { phases, families, abort, close, malformedReplyCode }) {
  const parse = frame => run('parse', frame);
  const accepted = frame => {
    const result = parse(frame); assert.equal(result.accepted, true, 'synthetic frame rejected'); return result.frame;
  };
  const readyFrame = protocolVersion => ({ kind: 'lifecycle', phase: 'ready', protocolVersion });
  function ready(sessionPhase, wire) {
    const frame = accepted(wire);
    const detail = run('repeated', sessionPhase) ? run('repeatDetail') : run('incompatible', frame) ? run('versionDetail', frame) : null;
    return detail === null ? { frame, nextPhase: phases.serving } :
      { frame, outbound: accepted(run('protocolShutdown', detail)), nextPhase: phases.settled };
  }
  function event(family, payload, decoder) {
    const frame = accepted({ kind: 'event', family, payload }); return { frame, decoded: run(decoder, frame.payload) };
  }
  function request(number, method, args, demand) {
    const id = run('requestId', number);
    return accepted(run('request', id, method, args, ...(demand === undefined ? [] : [demand])));
  }
  const success = (requestId, input) => accepted({ kind: 'reply', requestId, outcome: { status: 'ok', value: input } });
  const promptArgs = (prompt, clientNonce) => ({ agentId: 'fixture-agent', prompt, clientNonce, directAddressedAcceptance: true });
  const normal = { hello: accepted(run('hello')), ready: ready(phases.before, readyFrame(3)), calls: [] };
  const cases = [
    ['listAgents', {}, [{ id: 'fixture-agent' }]],
    ['getAgentTranscriptTail', { agentId: 'fixture-agent' }, { entries: [], nextBeforeSeq: null }],
    ['sendPrompt', promptArgs('offline fixture', 'fixture-nonce-1'), { accepted: true }, 'person'],
  ];
  for (const [method, args, result, demand] of cases) {
    const outbound = request(normal.calls.length + 1, method, args, demand), inbound = success(outbound.requestId, result);
    const container = run('container', method, inbound.outcome.value); assert.ok(container.valid);
    normal.calls.push({ outbound, inbound, container });
  }
  normal.events = [...['connected', 'down'].map(state => event(families[0], { state }, 'state')),
    ...['server', 'gateway'].map(source => event(families[1], { source }, 'source'))];
  const nullSendResult = run('container', 'sendPrompt', null);
  const wrongContainers = [['listAgents', {}], ['getAgentTranscriptTail', { entries: 'fixture' }],
    ['getAgentTranscriptTail', { entries: [], nextBeforeSeq: '1' }], ['getAgentTranscriptTail', { entries: [], cloudAgentPeerIds: [1] }],
    ['sendPrompt', 17]].map(([method, input]) => ({ method, input, container: run('container', method, input), staticCode: malformedReplyCode }));
  assert.ok(wrongContainers.every(c => !c.container.valid));
  const malformedFrames = [
    ['non-record', []], ['ready/string-version', readyFrame('3')], ['event/missing-payload', { kind: 'event', family: families[0] }],
    ['event/empty-family', { kind: 'event', family: '', payload: null }], ['cancel/empty-id', { kind: 'cancel', requestId: '' }],
    ['request/missing-args', { kind: 'request', requestId: 'r-1', method: methods[0] }],
    ['request/bad-demand', { ...normal.calls[0].outbound, demand: 'unknown' }],
    ['reply/missing-value', { kind: 'reply', requestId: 'r-1', outcome: { status: 'ok' } }],
    ['reply/missing-code', { kind: 'reply', requestId: 'r-1', outcome: { status: 'failed', failure: { message: 'fixture' } } }],
    ['shutdown/missing-detail', { kind: 'lifecycle', phase: 'shutdown', reason: 'requested' }],
    ['shutdown/empty-detail', { kind: 'lifecycle', phase: 'shutdown', reason: 'protocol-error', detail: '' }],
  ].map(([caseId, frame]) => {
    const result = parse(frame); assert.equal(result.accepted, false, caseId); return { caseId, frame, rejection: result.rejection };
  });
  const negative = { duplicateReady: ready(normal.ready.nextPhase, readyFrame(3)), wrongVersion: ready(phases.before, readyFrame(4)),
    state: ['online', 'reconnecting', 'disconnected', 3].map(state => event(families[0], { state }, 'state')),
    transcriptSource: event(families[1], { source: 'unknown' }, 'source'), malformedFrames, wrongContainers };

  const outstanding = request(4, 'sendPrompt', promptArgs('cancel fixture', 'fixture-nonce-2'));
  const cancelGuard = (phase, pendingIds) => run('abortPermitted', phase, pendingIds, outstanding.requestId);
  const pendingGuards = { active: cancelGuard(phases.serving, [outstanding.requestId]),
    alreadyReplied: cancelGuard(phases.serving, []), differentId: cancelGuard(phases.serving, ['r-other']),
    settled: cancelGuard(phases.settled, [outstanding.requestId]) };
  const cancel = pendingGuards.active ? accepted(run('cancel', outstanding.requestId)) : null;
  const failure = accepted({ kind: 'reply', requestId: outstanding.requestId, outcome: {
    status: 'failed', failure: { code: 'cancelled', message: 'synthetic cancellation' } } });
  const cancellation = { preAbortedGuard: run('preAborted', { signal: { aborted: true } }),
    liveSignalGuard: run('preAborted', { signal: { aborted: false } }), pendingGuards, outboundRequest: outstanding, outboundCancel: cancel,
    inboundFailure: failure, staticFailureCode: abort.failureCode };
  const stillPending = request(5, 'getAgentTranscriptTail', { agentId: 'fixture-agent' });
  const closure = { pendingRequest: stillPending, localDisposeFrame: accepted(run('requestedShutdown')),
    peerShutdownFrame: accepted({ kind: 'lifecycle', phase: 'shutdown', reason: 'requested', detail: null }),
    portClosed: { outboundFrames: [], invokesCleanup: run('notSettled', phases.serving), staticPendingFailureCode: close.pendingFailureCode,
      staticStateNotification: close.notifies, repeatedCloseInvokesCleanup: run('notSettled', phases.settled) },
    lateReply: { frame: success(stillPending.requestId, { entries: [] }), ignoreWhileServing: run('ignoreMessage', phases.serving),
      ignoreAfterClose: run('ignoreMessage', phases.settled) } };
  return { normal, nullSendResult, negative, cancellation, closure };
}

export function replayCoordinator(file) {
  const selection = selections(authenticatedMembers(file));
  const { contract, fragments } = senderEvidence(selection);
  const result = transcript(pureRealm(selection, fragments), contract);
  return {
    evidence: 'isolated-component', platform: 'windows-x64', version: identity.version,
    input: { archiveSha256: identity.archiveSha256, archiveBytes: identity.archiveBytes, headerSha256: identity.headerSha256,
      members: Object.values(members).map(([member, bytes, sha256]) => ({ member, bytes, sha256 })) },
    static: { ...contract, methods: selection.table, ranges: selection.ranges },
    isolated: { pureFunctionsSha256: pureDigest, senderExpressionsSha256: expressionDigest, pendingGuardsSha256: pendingGuardsDigest, transcript: result },
    limits: { fixtureOnly: true, sendPromptArgs: 'Project Host fixture fields: forwarded, not validated as an official schema.',
      lifecycleEffects: 'AST-traced, not executed', portEvents: 'synthetic, not delivered',
      moduleExecuted: false, nativePreloadExecuted: false, coordinatorInstantiated: false, nativeVerified: false },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 || !process.env.PROKBOT_WINDOWS_110_ASAR)
      throw new Error('Set PROKBOT_WINDOWS_110_ASAR to a local stock ASAR; run node --single-threaded --max-old-space-size=64 --expose-internals coordinator-replay.mjs');
    console.log(JSON.stringify(replayCoordinator(process.env.PROKBOT_WINDOWS_110_ASAR), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
