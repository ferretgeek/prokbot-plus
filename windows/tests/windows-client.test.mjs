import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { carveSevenZip } from '../patchers/desktop/original.mjs';
import os from 'node:os';
import path from 'node:path';
import { align, mapRange } from '../tools/byte-align.mjs';
import { replaceAsarIntegrity } from '../patchers/desktop/pe.mjs';
import { writeZip } from '../patchers/desktop/zip.mjs';
import { titleBarOverlay, windowChrome, initialLink } from '../../mac/clients/desktop/platform.mjs';
import { windowsNativeCodex, findCodex } from '../../mac/clients/desktop/codex-process.mjs';
import { remoteAttachmentPath } from '../../mac/clients/desktop/attachments.mjs';
import { loadLocalExecDaemon } from '../../mac/clients/desktop/local-exec.mjs';

const pad = text => `${'/* shared prefix that anchors the alignment */'.repeat(2)}${text}${'/* shared suffix that anchors the alignment */'.repeat(2)}`;

test('an explicit installer must match both the wrapper and embedded archive', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-wrapper-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = Buffer.alloc(32); Buffer.from('377abcaf271c', 'hex').copy(payload);
  const wrapper = Buffer.concat([Buffer.from('MZ'), payload]);
  const pin = data => ({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  const exe = path.join(dir, 'test.exe'), out = path.join(dir, 'test.7z'), original = pin(wrapper);
  await writeFile(exe, wrapper);
  await carveSevenZip(exe, out, pin(payload), original);
  assert.deepEqual(await readFile(out), payload);
  wrapper[0] ^= 1; await writeFile(exe, wrapper);
  await assert.rejects(carveSevenZip(exe, out, pin(payload), original), /摘要不匹配/);
});

test('failed ZIP builds preserve existing output and remove only their own partial file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-zip-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'keep.zip'), missing = path.join(dir, 'absent');
  await writeFile(target, 'keep');
  await assert.rejects(writeZip(missing, target, { prefix: 'test' }), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'keep');
  const partial = path.join(dir, 'partial.zip');
  await assert.rejects(writeZip(missing, partial, { prefix: 'test' }), { code: 'ENOENT' });
  await assert.rejects(readFile(partial), { code: 'ENOENT' });
});

test('a copied range keeps every byte the Windows build reorders inside it', () => {
  // The two builds list the same registry entries in a different order.
  const mac = Buffer.from(pad('modules=[{get Code(){return Re}},{get ConnectError(){return zt}},{get i18n(){return lt}},de,gwe,Swe,_we,Ewe];'));
  const win = Buffer.from(pad('modules=[de,gwe,{get i18n(){return lt}},Swe,{get Code(){return Re}},{get ConnectError(){return zt}},_we,Ewe];'));
  const segments = align(mac, win);
  const [[offset, length], ...rest] = mapRange(0, mac.length, segments, { a: mac.length, b: win.length });
  assert.deepEqual(rest, []);
  assert.equal(win.subarray(offset, offset + length).toString(), win.toString());
});

test('a copy boundary inside a platform difference is rejected', () => {
  const mac = Buffer.from(pad('buildId:"ffcda8af-8cbf-49a2-b000-103a5e37f6c9"'));
  const win = Buffer.from(pad('buildId:"41293fa0-ee0c-4047-9034-d6ce50700913"'));
  const boundary = mac.indexOf('ffcda8af') + 4;
  assert.throws(() => mapRange(0, boundary, align(mac, win), { a: mac.length, b: win.length }), /platform difference/);
});

test('the embedded ASAR integrity value is replaced in place', () => {
  const original = 'a'.repeat(64), replacement = 'b'.repeat(64);
  const exe = Buffer.from(`MZ....[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${original}"}]....`, 'latin1');
  const result = replaceAsarIntegrity(exe, original, replacement);
  assert.equal(result.length, exe.length);
  assert.ok(result.toString('latin1').includes(replacement));
  assert.throws(() => replaceAsarIntegrity(exe, 'c'.repeat(64), replacement), /does not match/);
});

test('the zip archive round-trips names, contents and the version comment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grokbot-zip-test-'));
  try {
    const source = path.join(root, 'app');
    await mkdir(path.join(source, 'resources', '中文'), { recursive: true });
    await writeFile(path.join(source, 'Grok Bot.exe'), Buffer.alloc(4096, 7));
    await writeFile(path.join(source, 'resources', '中文', 'note.txt'), 'hello');
    const archive = path.join(root, 'out.zip');
    const { entries } = await writeZip(source, archive, { prefix: 'Grok Bot Local', comment: '0.71.2' });
    assert.equal(entries, 2);
    const bytes = await readFile(archive);
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.equal(bytes.toString('utf8', end + 22), '0.71.2');
    let at = bytes.readUInt32LE(end + 16);
    const files = {};
    for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
      const method = bytes.readUInt16LE(at + 10), compressed = bytes.readUInt32LE(at + 20), nameLength = bytes.readUInt16LE(at + 28);
      const local = bytes.readUInt32LE(at + 42), name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const body = bytes.subarray(start, start + compressed);
      files[name] = method === 8 ? inflateRawSync(body) : body;
      at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    assert.deepEqual(Object.keys(files).sort(), ['Grok Bot Local/Grok Bot.exe', 'Grok Bot Local/resources/中文/note.txt']);
    assert.equal(files['Grok Bot Local/resources/中文/note.txt'].toString(), 'hello');
    assert.ok(files['Grok Bot Local/Grok Bot.exe'].equals(Buffer.alloc(4096, 7)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows chrome follows the original title-bar overlay values', () => {
  assert.deepEqual(titleBarOverlay('#111111'), { color: '#111111', symbolColor: '#FFFFFF', height: 51 });
  assert.deepEqual(titleBarOverlay('#ffffff'), { color: '#ffffff', symbolColor: '#000000', height: 51 });
  assert.equal(titleBarOverlay('#111111', true).height, 43);
  assert.deepEqual(windowChrome('#111111', 'win32').frame, false);
  assert.deepEqual(windowChrome('#111111', 'darwin'), { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } });
  assert.equal(initialLink(['Grok Bot.exe', '--flag', 'grokbot-local://agent/abc']), 'grokbot-local://agent/abc');
  assert.equal(initialLink(['Grok Bot.exe']), null);
});

test('Windows npm candidates use the requested architecture regardless of the test host', () => {
  for (const [arch, triple] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    const [native] = windowsNativeCodex('C:\\npm', arch);
    assert.equal(native, path.win32.join('C:\\npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      `codex-win32-${arch}`, 'vendor', `${triple}-pc-windows-msvc`, 'bin', 'codex.exe'));
  }
});

test('the npm Codex launcher resolves to its native Windows binary', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grokbot-codex-test-'));
  try {
    const native = windowsNativeCodex(root)[0];
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, '');
    await writeFile(path.join(root, 'codex.cmd'), '@echo off');
    assert.equal(await findCodex({ platform: 'win32', env: { PATH: root } }), native);
    assert.equal(await findCodex({ platform: 'win32', env: { PATH: path.join(root, 'missing') } }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Host attachment file URLs stay POSIX paths on Windows', () => {
  // The Linux Host records generated images and screenshots as file URLs without a drive letter.
  assert.equal(remoteAttachmentPath('file:///data/runtime/host-data/agents/a/attachments/x%20y.png'),
    '/data/runtime/host-data/agents/a/attachments/x y.png');
  assert.equal(remoteAttachmentPath('/data/agents/a/assets/b.png'), '/data/agents/a/assets/b.png');
  assert.equal(remoteAttachmentPath('https://example.com/a.png'), null);
  assert.equal(remoteAttachmentPath('file:///data/a%2Fb.png'), null);
});

test('the Windows command daemon gets its UTF-8 console option', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'daemon-test-'));
  try {
    const file = path.join(directory, 'main.cjs');
    // Same shape as the shipped 0.71.2 Windows daemon: the sixth argument is powershellUtf8Console.
    await writeFile(file, `class e3 { constructor(e, r, n, i, s, o, a) { this.utf8 = o; this.keep = a; } }
function iZe(t) { let i = {}, s = !0; return new e3(i,t,t,void 0,void 0,void 0,s); }
module.exports = { make: iZe, dir: __dirname };`);
    const windows = loadLocalExecDaemon(file, 'win32');
    assert.deepEqual([windows.make('w').utf8, windows.make('w').keep, windows.dir], [true, true, directory]);
    // Other platforms load the daemon unchanged.
    assert.equal(loadLocalExecDaemon(file, 'darwin').make('m').utf8, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
