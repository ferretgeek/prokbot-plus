import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAttachmentUploads } from '../clients/desktop/attachment-uploads.mjs';
import { createAttachmentHandlers, createAttachmentMediaResolver } from '../clients/desktop/attachments.mjs';
import { setLocaleSource } from '../clients/desktop/i18n.mjs';

setLocaleSource(() => 'en');
const chunk = 4 * 1024 * 1024;
const unexpected = () => { throw new Error('Unexpected Host request for a local draft'); };

async function fixture(t, command = unexpected, onProgress) {
  const profile = await mkdtemp(path.join(tmpdir(), 'prokbot-attachment-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const uploads = createAttachmentUploads({ profile, command, onProgress });
  const staging = path.join(profile, 'attachment-staging');
  const destination = path.join(profile, 'saved.txt');
  const errors = [];
  const attachments = createAttachmentHandlers({ ...uploads, command,
    chooseDestination: async () => destination, showDownloadError: async () => errors.push('download') });
  return { ...uploads.handlers, ...attachments, profile, staging, destination, errors };
}

test('picked and pasted drafts preview and save locally through both native paths and file URLs', async t => {
  const f = await fixture(t), filename = 'notes.txt';
  const sourcePath = path.join(f.profile, filename), bytes = Buffer.from('draft, not yet uploaded');
  await writeFile(sourcePath, bytes);
  for (const stage of [() => f.stageAttachmentBytes({ filename, bytes }), () => f.stageAttachmentPath({ filename, sourcePath })]) {
    const staged = await stage();
    assert.equal(staged.ok, true);
    const aliases = [staged.path, pathToFileURL(staged.path).href];
    if (process.platform === 'win32') aliases.push(staged.path.replaceAll('\\', '/'));
    for (const source of aliases) {
      assert.deepEqual(await f.readAttachmentText({ path: source }), { kind: 'text', text: bytes.toString(), bytes: bytes.length, truncated: false });
      assert.deepEqual(await f.readAttachmentBytes({ path: source, maxBytes: 1 }), { kind: 'too-large', size: bytes.length });
      assert.deepEqual(await f.readAttachmentBytes({ path: source }), { kind: 'bytes', bytes: Uint8Array.from(bytes), size: bytes.length });
      assert.equal(await f.downloadAttachment({ path: source, suggestedName: filename }), true);
      assert.deepEqual(await readFile(f.destination), bytes);
    }
    await f.discardStagedAttachment({ path: staged.path });
  }
  assert.deepEqual(f.errors, []);
  assert.deepEqual(await readdir(f.staging), []);
  assert.deepEqual(await readFile(sourcePath), bytes);
});

test('staging errors do not create a draft or change the picked file', async t => {
  const f = await fixture(t), filename = 'empty.txt';
  const sourcePath = path.join(f.profile, filename);
  await writeFile(sourcePath, '');
  assert.deepEqual(await f.stageAttachmentBytes({ filename, bytes: Buffer.alloc(0) }), { ok: false, reason: 'empty' });
  assert.deepEqual(await f.stageAttachmentPath({ filename, sourcePath }), { ok: false, reason: 'empty' });
  assert.deepEqual(await f.stageAttachmentPath({ filename, sourcePath: path.join(f.profile, 'missing') }), { ok: false, reason: 'failed' });
  assert.deepEqual(await f.stageAttachmentBytes({ filename, bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }), { ok: false, reason: 'too-large' });
  assert.deepEqual(await readdir(f.profile), [filename]);
});

test('staged preview reads only its displayed prefix and never allocates oversized video bytes', async () => {
  const head = 6 * 1024 * 1024, sizes = { 'note.md': head + 8, 'long.mp4': 200 * 1024 * 1024 };
  const reads = [];
  const withStaged = (name, read) => read({ async read(buffer, start, length, offset) {
    reads.push({ name, length, offset }); buffer.fill(65, start, start + length); return { bytesRead: length };
  } }, sizes[name]);
  const f = createAttachmentHandlers({ command: unexpected, withStaged });
  assert.deepEqual(await f.readAttachmentBytes({ path: 'long.mp4' }), { kind: 'too-large', size: sizes['long.mp4'] });
  const media = createAttachmentMediaResolver({ command: unexpected, withStaged, nativeImage: {} });
  await assert.rejects(media({ source: 'long.mp4' }), /too large to preview/i);
  const text = await f.readAttachmentText({ path: 'note.md' });
  assert.equal(text.bytes, sizes['note.md']); assert.equal(text.text.length, head); assert.equal(text.truncated, true);
  const bytes = await f.readAttachmentBytes({ path: 'note.md' });
  assert.equal(bytes.size, sizes['note.md']); assert.equal(bytes.bytes.length, head);
  assert.deepEqual(reads, Array.from({ length: 2 }, () => ({ name: 'note.md', length: head, offset: 0 })));
});

test('slow uploads retain a deadline for each chunk and do not time out while making progress', async t => {
  let now = 0, elapsed = 70000;
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController(); deadlines.push({ end: now + ms, controller }); return controller.signal;
  });
  const f = await fixture(t, async (_method, args, signal) => {
    now += elapsed;
    for (const deadline of deadlines) if (deadline.end <= now) deadline.controller.abort();
    signal.throwIfAborted();
    return args.offset ? { committedPath: '/fixture/video' } : {};
  });
  const filename = 'slow.mp4', sourcePath = path.join(f.profile, filename);
  await writeFile(sourcePath, Buffer.alloc(chunk + 1, 3));
  const staged = await f.stageAttachmentPath({ filename, sourcePath });
  const args = { agentId: 'agent-a', paths: [staged.path], filenames: [filename] };
  assert.deepEqual(await f.commitStagedAttachments(args), ['/fixture/video']);
  elapsed = 121000;
  await assert.rejects(f.commitStagedAttachments({ ...args, agentId: 'agent-b' }), { name: 'AbortError' });
  await f.discardStagedAttachment({ path: staged.path });
});

test('the same draft has one commit across native path and URL aliases; discard forgets both', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ({ committedPath: `/fixture/upload-${++calls}` }));
  const filename = 'item.txt', staged = await f.stageAttachmentBytes({ filename, bytes: Buffer.from('item') });
  const url = pathToFileURL(staged.path).href;
  const commit = source => f.commitStagedAttachments({ agentId: 'agent-a', paths: [source], filenames: [filename] });
  const [one, two] = await Promise.all([commit(url), commit(staged.path)]);
  assert.deepEqual(one, two);
  assert.equal(calls, 1);
  assert.deepEqual(await commit(url), one);
  await f.discardStagedAttachment({ path: staged.path });
  await assert.rejects(commit(url));
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(f.staging), []);
});

test('invalid entries anywhere in a batch reject before uploading any of its drafts', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { committedPath: '/fixture/item' }; });
  const filename = 'item.txt', staged = await f.stageAttachmentBytes({ filename, bytes: Buffer.from('item') });
  const paths = Array(2); paths[0] = staged.path;
  const filenames = Array(2); filenames[0] = filename;
  await assert.rejects(f.commitStagedAttachments({ agentId: 'agent-a', paths, filenames: [filename, filename] }), /Invalid attachment upload/);
  await assert.rejects(f.commitStagedAttachments({ agentId: 'agent-a', paths: [staged.path, staged.path], filenames }), /Invalid attachment upload/);
  assert.equal(calls, 0);
  await f.discardStagedAttachment({ path: staged.path });
});

test('an unacknowledged final chunk never reports completion and a retry keeps the original bytes', async t => {
  const bytes = Buffer.alloc(chunk + 23, 65), received = [], progress = [];
  let acknowledge = false;
  const f = await fixture(t, async (method, args) => {
    assert.equal(method, 'uploadAttachmentChunk');
    const part = Buffer.from(args.bytesBase64, 'base64');
    received.push({ id: args.uploadId, offset: args.offset, length: part.length });
    assert.deepEqual(part, bytes.subarray(args.offset, args.offset + part.length));
    return acknowledge && args.offset + part.length === args.totalSize ? { committedPath: '/fixture/final' } : {};
  }, value => progress.push(value.fraction));
  const filename = 'retry.bin', staged = await f.stageAttachmentBytes({ filename, bytes });
  const args = { agentId: 'agent-a', paths: [staged.path], filenames: [filename], progressKey: 'progress' };
  await assert.rejects(f.commitStagedAttachments(args));
  assert.ok(progress.every(fraction => fraction < 1), 'a failed commit must not show 100%');
  acknowledge = true;
  assert.deepEqual(await f.commitStagedAttachments(args), ['/fixture/final']);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(received.map(({ offset }) => offset), [0, chunk, 0, chunk]);
  assert.notEqual(received[0].id, received[2].id);
  await f.discardStagedAttachment({ path: staged.path });
  assert.deepEqual(await readdir(f.staging), []);
});

test('discard cancels an in-flight commit before removing its file, including repeated discard', async t => {
  let signal;
  const started = Promise.withResolvers(), reply = Promise.withResolvers();
  const f = await fixture(t, async (_method, _args, requestSignal) => {
    signal = requestSignal; started.resolve();
    signal.addEventListener('abort', () => reply.reject(signal.reason), { once: true });
    return reply.promise;
  });
  const filename = 'draft.txt', staged = await f.stageAttachmentBytes({ filename, bytes: Buffer.from('draft') });
  const args = { agentId: 'agent-a', paths: [staged.path], filenames: [filename] };
  const commit = f.commitStagedAttachments(args);
  const outcome = commit.then(() => 'committed', () => 'cancelled');
  await started.promise;
  const discards = [staged.path, pathToFileURL(staged.path).href].map(source => f.discardStagedAttachment({ path: source }));
  const aborted = signal.aborted;
  reply.resolve({ committedPath: '/fixture/stale' });
  await Promise.all(discards);
  assert.equal(await outcome, 'cancelled');
  assert.equal(aborted, true);
  await assert.rejects(f.commitStagedAttachments(args));
  assert.deepEqual(await readdir(f.staging), []);
});

test('a remote chunk failure preserves the destination and removes the partial download', async t => {
  const bytes = Buffer.alloc(chunk, 49);
  const f = await fixture(t, async (_method, { offset, length }) => {
    if (offset === chunk) throw new Error('fixture interruption');
    return { totalSize: chunk + 1, bytesBase64: length ? bytes.toString('base64') : '' };
  });
  await writeFile(f.destination, 'previous contents');
  assert.equal(await f.downloadAttachment({ path: 'file:///fixture/report.txt' }), false);
  assert.deepEqual(f.errors, ['download']);
  assert.equal(await readFile(f.destination, 'utf8'), 'previous contents');
  assert.deepEqual(await readdir(f.profile), [path.basename(f.destination)]);
});
