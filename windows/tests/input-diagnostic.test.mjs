import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import nativeFs, { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { withInstallerDiagnostic } from '../patchers/desktop/input-diagnostic.mjs';
import { snapshotPayload } from '../patchers/desktop/snapshot-payload.mjs';

const repo = new URL('../../', import.meta.url);
const readJson = async url => JSON.parse(await fs.readFile(url, 'utf8'));
const known = await readJson(new URL('windows/patchers/desktop/known-unsupported.json', repo));
const supported = await readJson(new URL('windows/patchers/desktop/supported.json', repo));
const sample = Buffer.alloc(2 * 65536 + 17, 'x'); // Non-executable; spans multiple stream reads.
const pin = data => ({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });

async function disposable(t) {
  const base = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'grokbot-input-diagnostic-'));
  assert.equal(path.dirname(await fs.realpath(root)), base);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Exercise the shipping CLI with a tiny diagnostic fingerprint, without packaging vendor bytes or CI.
async function fixtureRelease(root) {
  for (const relative of ['windows/patchers/desktop/', 'mac/patchers/desktop/']) {
    const from = new URL(relative, repo), to = path.join(root, relative);
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (entry.isFile() && /\.(mjs|json)$/.test(entry.name)) await fs.copyFile(new URL(entry.name, from), path.join(to, entry.name));
    }
  }
  const desktop = path.join(root, 'windows/patchers/desktop');
  await fs.writeFile(path.join(desktop, 'known-unsupported.json'), JSON.stringify({ ...known,
    archiveBytes: sample.length, observedArchiveSha256: pin(sample).sha256 }));
  return desktop;
}

function observeIO(t, beforeStream = () => {}) {
  const streams = [], realOpen = fs.open;
  const open = t.mock.method(fs, 'open', async (source, flags) => {
    const file = await realOpen(source, flags), createStream = file.createReadStream.bind(file);
    t.mock.method(file, 'createReadStream', options => {
      beforeStream(source);
      const stream = createStream(options);
      streams.push({ source, flags, options, stream });
      return stream;
    });
    return file;
  });
  const pathStreams = t.mock.method(nativeFs, 'createReadStream');
  const reads = [open, t.mock.method(fs, 'stat'), t.mock.method(fs, 'readFile'), pathStreams];
  syncBuiltinESMExports();
  t.after(() => { for (const read of reads) read.mock.restore(); syncBuiltinESMExports(); });
  return { streams, open, pathStreams, reads };
}

test('the packaged diagnostic names only the recorded whole Windows 1.1.0 installer', () => {
  assert.equal(known.version, '1.1.0'); assert.equal(known.archiveBytes, 127403656);
  assert.equal(known.observedArchiveSha256, '01ccb10f2144ea0eb787042c54fc4b8ca2c6f43eccb7dabe5fe5eb86fa5ed044');
  assert.notEqual(supported.archive.sha256, known.observedArchiveSha256);
});

test('only a rejected installer of the known size gets one read-only bounded stream', async t => {
  const root = await disposable(t), desktop = await fixtureRelease(root), source = path.join(root, 'renamed.EXE');
  const { withInstallerDiagnostic: diagnose } = await import(pathToFileURL(path.join(desktop, 'input-diagnostic.mjs')));
  const verify = () => diagnose(snapshotPayload(source, root, supported), source, supported);
  let append = false;
  const { open, pathStreams, streams } = observeIO(t, name => { if (append) appendFileSync(name, '!'); });
  await fs.writeFile(source, sample.subarray(1));
  await assert.rejects(verify(), /origin of this file are unverified/);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(pathStreams.mock.callCount(), 0);

  await fs.writeFile(source, sample);
  await assert.rejects(verify(), /official Grok Bot 1\.1\.0 installer is incompatible/);
  append = true; // The prefix is still a match, but it is no longer the whole file.
  await assert.rejects(verify(), /origin of this file are unverified/);
  assert.equal(open.mock.callCount(), 2);
  assert.equal(pathStreams.mock.callCount(), 0);
  assert.equal(streams.length, 2);
  for (const read of streams) {
    assert.equal(read.source, source);
    assert.equal(read.flags, 'r');
    assert.deepEqual([read.options.start, read.options.end, read.stream.bytesRead], [0, sample.length - 1, sample.length]);
  }
});

test('a supported archive and errors outside explicit EXE pin verification perform no diagnostic I/O', async t => {
  const root = await disposable(t), source = path.join(root, 'supported.exe');
  const payload = Buffer.alloc(32);
  Buffer.from('377abcaf271c', 'hex').copy(payload);
  const wrapper = Buffer.concat([Buffer.from('fixture'), payload]);
  const pins = { ...supported, archive: pin(wrapper), payload: pin(payload) };
  await fs.writeFile(source, wrapper);
  const verified = snapshotPayload(source, root, pins);
  const result = await verified; // Count only additional I/O after the usual positive checks.
  assert.deepEqual(await fs.readFile(result), payload);
  const { reads } = observeIO(t);
  assert.equal(await withInstallerDiagnostic(verified, source, pins), result);
  assert.equal(await withInstallerDiagnostic(Promise.resolve(root), root, pins), root);
  const mismatch = new Error('官方安装包摘要不匹配。');
  for (const [input, cause] of [[null, mismatch], [path.join(root, 'app-64.7z'), mismatch], [root, mismatch],
    [source, new Error('安装包中没有找到受支持的程序包。')], [source, new Error('EACCES')]]) {
    await assert.rejects(withInstallerDiagnostic(Promise.reject(cause), input, pins), error => error === cause);
  }
  for (const read of reads) assert.equal(read.mock.callCount(), 0);
});

test('standalone Windows CLI rejects a renamed exact installer and an altered namesake without touching output',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await disposable(t), desktop = await fixtureRelease(root), output = path.join(root, 'output');
    const keep = `GrokBotLocal-${supported.version}-x64.patch.json`;
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, keep), 'previous build');
    const corrupt = Buffer.from(sample);
    corrupt[corrupt.length - 1] ^= 1;
    for (const [name, bytes, exact] of [['renamed.EXE', sample, true], ['Grok_Bot_1.1.0_Setup.exe', corrupt, false]]) {
      const source = path.join(root, name);
      await fs.writeFile(source, bytes);
      await assert.rejects(promisify(execFile)(process.execPath, [path.join(desktop, 'patch.mjs'), '--source', name, '--output', output],
        { cwd: root, windowsHide: true, timeout: 10000 }), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        if (exact) assert.match(error.stderr, /official Grok Bot 1\.1\.0 installer is incompatible with this ProkBot Plus patch/);
        else {
          assert.match(error.stderr, /origin of this file are unverified/);
          assert.doesNotMatch(error.stderr, /official|官方|1\.1\.0/i);
        }
        assert.match(error.stderr, /Pairing did not run/);
        assert.ok(error.stderr.includes(`Omit --source to fetch the exact supported Grok Bot ${supported.version} Windows ${supported.architecture}`));
        assert.match(error.stderr, /No need to uninstall your existing app/);
        return true;
      });
      assert.deepEqual(await fs.readFile(source), bytes);
      assert.deepEqual(await fs.readdir(output), [keep]);
      assert.equal(await fs.readFile(path.join(output, keep), 'utf8'), 'previous build');
    }
  });
