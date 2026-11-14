import assert from 'node:assert/strict';
import { inspectPreload } from '../../inspect-desktop-preload.mjs';
import { members } from './candidate.mjs';
import { calls, find, moduleShape, name, only, prop, value } from './ast.mjs';

export function inspectCandidateIpc(bytes) {
  const direct = inspectPreload(bytes, members.preload[1]), m = moduleShape(bytes, 'commonjs');
  const one = (n, f, label) => only(find(n, f), label);
  const world = key => one(m.tree, n => n.type === 'CallExpression' && n.callee.property?.name === 'exposeInMainWorld' && value(n.arguments[0]) === key, key);
  const declared = world('desktop'), desktop = m.defs.get(declared.arguments[1].name);
  const destructure = id => one(m.tree, n => n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && n.id.properties.some(p => p.type === 'RestElement' && p.argument.name === id), 'desktop bridge binding');
  const boot = destructure(prop(desktop, 'boot').name), main = destructure(prop(desktop, 'main').name);
  assert.equal(boot.init.callee.property.name, 'sendSync'); assert.equal(boot.init.callee.object.property.name, 'ipcRenderer');
  assert.equal(value(m.defs.get(boot.init.callee.object.object.name).arguments[0]), 'electron');
  assert.equal(value(boot.init.arguments[0]), 'sand:boot-snapshot-sync'); assert.ok(prop(boot.id, 'mainEdge'));
  const resolve = id => { const n = m.defs.get(id); assert.ok(n); return n.type === 'Identifier' ? resolve(n.name) : n; };
  const rpc = resolve(main.init.arguments[0].name), bridge = m.defs.get(main.init.callee.name);
  const transport = resolve(main.init.arguments[1].name), gate = resolve(transport.arguments[0].name);
  assert.equal(gate.arguments[0].name, prop(boot.id, 'mainEdge').name);
  one(resolve(gate.callee.name), n => value(n) === 'served', 'served edge gate');
  const notification = one(gate, n => n.type === 'CallExpression' && n.callee.property?.name === 'once' && n.callee.object.property?.name === 'ipcRenderer', 'edge-ready notification');
  const gateEvent = value(resolve(notification.arguments[0].name)); assert.equal(gateEvent, 'sand:main-edge-served');
  const success = one(bridge, n => n.type === 'IfStatement' && n.test.property?.name === 'ok' && n.consequent.argument?.property?.name === 'value', 'RPC success envelope');
  assert.equal(success.test.object.name, success.consequent.argument.object.name);
  assert.ok(prop(main.id, 'stageAttachmentPath')); assert.ok(prop(prop(desktop, 'local'), 'stageAttachmentFile'));
  assert.equal(value(rpc.arguments[0]), 'main');
  const maps = prop(rpc.arguments[1], 'methods'), declarations = new Map();
  function collect(map) {
    if (map.type === 'Identifier') return collect(resolve(map.name));
    assert.equal(map.type, 'ObjectExpression');
    for (const p of map.properties) {
      if (p.type === 'SpreadElement') { collect(p.argument); continue; }
      const key = name(p), v = p.value, kind = v.callee?.property?.name ?? v.property?.name;
      assert.ok(['args', 'noArgs'].includes(kind)); assert.ok(!declarations.has(key), 'duplicate main RPC');
      declarations.set(key, { kind, fields: v.arguments?.[0]?.properties?.map(name) ?? [] });
    }
  }
  collect(maps);
  const channels = {};
  for (const call of find(bridge, n => n.type === 'CallExpression' && ['invoke', 'on'].includes(n.callee?.property?.name))) {
    const builder = call.arguments[0]; if (builder?.type !== 'CallExpression' || builder.arguments[0]?.property?.name !== 'edge') continue;
    const ret = resolve(builder.callee.name).body.body[0].argument; assert.equal(ret.type, 'TemplateLiteral');
    const pattern = ret.quasis.map(q => q.value.cooked);
    if (pattern.join('{}') === 'dune-rpc:{}:probe') channels.probe = call.callee.property.name;
    if (pattern.join('{}') === 'dune-rpc:{}:m:{}') channels.method = call.callee.property.name;
    if (pattern.join('{}') === 'dune-rpc:{}:e:{}') channels.event = call.callee.property.name;
  }
  assert.deepEqual(channels, { method: 'invoke', probe: 'invoke', event: 'on' });
  const fields = Object.fromEntries(['readManyClientPersistence', 'writeClientPersistence', 'stageAttachmentPath', 'resolveAttachmentMedia'].map(k => [k, declarations.get(k).fields]));
  const port = world('coordinatorPort'), exposed = resolve(port.arguments[1].name); assert.equal(exposed.property.name, 'bridge');
  const created = resolve(exposed.object.name), claim = resolve(created.callee.name);
  one(claim, n => n.type === 'Property' && name(n) === 'claim', 'port claim'); one(claim, n => n.type === 'Property' && name(n) === 'release', 'port release');
  one(created, n => n.type === 'CallExpression' && n.callee.property?.name === 'invoke' && value(n.arguments[0]) === 'sand:coordinator-port-request', 'request port');
  const receipt = one(m.tree, n => n.type === 'CallExpression' && n.callee.property?.name === 'on' && value(n.arguments[0]) === 'sand:coordinator-port', 'receive port');
  assert.equal(receipt.callee.object.property.name, 'ipcRenderer');
  const unwrap = resolve(one(receipt.arguments[1], n => n.type === 'CallExpression' && n.callee.type === 'Identifier', 'transferred port adapter').callee.name);
  one(unwrap, n => n.type === 'MemberExpression' && value(n.property) === 0 && n.object.property?.name === 'ports', 'first transferred port');
  one(unwrap, n => n.type === 'ConditionalExpression' && value(n.alternate) === null && n.consequent.property?.name === 'accountSlot', 'nullable slot');
  const wrapper = resolve(unwrap.body.body.at(-1).argument.callee.name);
  const portMethods = wrapper.body.body[0].argument.properties.map(name);
  for (const key of ['postMessage','start','close','addEventListener']) assert.ok(portMethods.includes(key));
  const post = prop(wrapper.body.body[0].argument, 'postMessage');
  const postCall = one(post, n => n.type === 'CallExpression' && n.callee.property?.name === 'postMessage', 'opaque frame forwarding');
  assert.equal(postCall.arguments[0].name, post.params[0].name);
  const unknown = one(bridge, n => n.type === 'BinaryExpression' && n.left?.property?.name === 'code' && value(m.defs.get(n.right?.name)) === 'edge/unknown-method', 'unknown method failure');
  assert.equal(unknown.left.object.property.name, 'failure');
  assert.ok(calls(m.tree, main.init.callee.name).length > 0);
  assert.equal(direct.legacyMethodCount, 0); assert.equal(declarations.size, 496);
  assert.equal(direct.lifecycle.length, 0); assert.equal(direct.literalProtocolVersions.length, 0);
  return { bytes: bytes.length, mainGroups: maps.properties.length, declaredMethods: declarations.size,
    withArgs: [...declarations.values()].filter(v => v.kind === 'args').length,
    noArgs: [...declarations.values()].filter(v => v.kind === 'noArgs').length,
    fixedRegistrarMatches: direct.legacyMethodCount, boot: 'sendSync', edgeReadyEvent: gateEvent, rpcChannels: channels, successEnvelope: ['ok', 'value'], selectedArgumentFields: fields,
    probeFailureCode: value(m.defs.get(unknown.right.name)), port: { claimRelease: true, request: 'invoke', delivery: 'on', transferredIndex: 0, nullableAccountSlot: true, opaqueOutboundFrames: true },
    coordinatorVersion: null, nativeVerified: false };
}
