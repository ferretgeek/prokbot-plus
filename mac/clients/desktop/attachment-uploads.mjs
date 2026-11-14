import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokText } from './i18n.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_LIMIT = 25 * 1024 * 1024;
const VIDEO_LIMIT = 200 * 1024 * 1024;
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name);
const byteLimit = name => /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|ogv)$/i.test(name) ? VIDEO_LIMIT : FILE_LIMIT;
const sizeFailure = (size, name) => size === 0 ? 'empty' : size > byteLimit(name) ? 'too-large' : null;

// The renderer owns the file picker and clipboard. Both enter through the
// original staging RPC, keeping its attachment previews and send journal.
export function createAttachmentUploads({ profile, command, onProgress = () => {} }) {
  const directory = path.join(profile, 'attachment-staging');
  const drafts = new Map();
  function draftFor(source) {
    if (!drafts.has(source)) drafts.set(source, { commits: new Map(), discarding: null });
    return drafts.get(source);
  }
  function localPath(source) {
    try {
      if (typeof source !== 'string') return null;
      const filename = /^file:/i.test(source) ? fileURLToPath(source) : source;
      if (!path.isAbsolute(filename)) return null;
      const name = path.relative(directory, filename);
      return /^[0-9a-f-]{36}(?:\.[a-zA-Z0-9]{1,16})?$/.test(name) ? path.join(directory, name) : null;
    } catch { return null; }
  }
  async function withStaged(source, read) {
    const filename = localPath(source);
    if (!filename) return null;
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > VIDEO_LIMIT) throw new Error('Invalid staged attachment');
      return await read(file, info.size);
    } finally { await file.close(); }
  }
  async function stage(filename, write) {
    if (!validName(filename)) return { ok: false, reason: 'failed' };
    const extension = /^\.[a-zA-Z0-9]{1,16}$/.test(path.extname(filename)) ? path.extname(filename) : '';
    const destination = path.join(directory, `${randomUUID()}${extension}`);
    let created = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const output = await open(destination, 'wx', 0o600);
      created = true;
      try { await write(output); } finally { await output.close(); }
      return { ok: true, path: destination };
    } catch {
      if (created) await rm(destination, { force: true }).catch(() => {});
      return { ok: false, reason: 'failed' };
    }
  }
  function upload({ agentId, path: source, filename }, cancel, progress) {
    return withStaged(source, async (input, size) => {
      if (sizeFailure(size, filename)) throw new Error(grokText('附件为空或超过大小限制。', 'The attachment is empty or too large.'));
      const uploadId = randomUUID();
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, size));
      let offset = 0;
      while (offset < size) {
        const signal = AbortSignal.any([cancel, AbortSignal.timeout(120000)]);
        const { bytesRead } = await input.read(bytes, 0, Math.min(bytes.length, size - offset), offset);
        if (!bytesRead) throw new Error('Staged attachment changed');
        signal.throwIfAborted();
        const result = await command('uploadAttachmentChunk', { agentId, uploadId, filename,
          offset, totalSize: size, bytesBase64: bytes.toString('base64', 0, bytesRead) }, signal);
        signal.throwIfAborted();
        offset += bytesRead;
        if (result?.committedPath) {
          if (offset !== size || typeof result.committedPath !== 'string') throw new Error('Incomplete attachment upload');
          return result.committedPath;
        }
        if (offset < size) progress(offset / size);
      }
      throw new Error(grokText('附件上传未完成，请重试。', 'The attachment upload did not complete. Try again.'));
    });
  }
  const handlers = {
    async stageAttachmentBytes({ filename, bytes }) {
      if (!validName(filename) || !(bytes instanceof Uint8Array)) return { ok: false, reason: 'failed' };
      const reason = sizeFailure(bytes.byteLength, filename);
      return reason ? { ok: false, reason } : stage(filename, file => file.writeFile(bytes));
    },
    async stageAttachmentPath({ filename, sourcePath }) {
      if (!validName(filename) || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return { ok: false, reason: 'failed' };
      let input;
      try {
        input = await open(sourcePath, 'r');
        const info = await input.stat();
        if (!info.isFile()) return { ok: false, reason: 'failed' };
        const reason = sizeFailure(info.size, filename);
        if (reason) return { ok: false, reason };
        return await stage(filename, async output => {
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, info.size));
          for (let offset = 0; offset < info.size;) {
            const { bytesRead } = await input.read(bytes, 0, Math.min(bytes.length, info.size - offset), offset);
            if (!bytesRead) throw new Error('Source attachment changed');
            await output.writeFile(bytes.subarray(0, bytesRead));
            offset += bytesRead;
          }
          if ((await input.stat()).size !== info.size) throw new Error('Source attachment changed');
        });
      } catch { return { ok: false, reason: 'failed' }; }
      finally { await input?.close(); }
    },
    async commitStagedAttachments({ agentId, paths, filenames, progressKey }) {
      if (typeof agentId !== 'string' || !agentId || !Array.isArray(paths) || !Array.isArray(filenames) ||
          paths.length !== filenames.length)
        throw new Error('Invalid attachment upload');
      const sources = Array.from(paths, localPath);
      if (sources.some((source, index) => !source || !validName(filenames[index]))) throw new Error('Invalid attachment upload');
      const report = fraction => { if (progressKey) onProgress({ key: progressKey, fraction }); };
      const results = [];
      report(0);
      for (let index = 0; index < paths.length; index++) {
        const source = sources[index], filename = filenames[index];
        const draft = draftFor(source), key = JSON.stringify([agentId, filename]);
        if (draft.discarding) throw new Error('Attachment was discarded');
        let entry = draft.commits.get(key);
        if (!entry) {
          const controller = new AbortController();
          const pending = upload({ agentId, path: source, filename }, controller.signal, fraction => report((index + fraction) / paths.length));
          entry = { controller, pending };
          draft.commits.set(key, entry);
          pending.catch(() => {
            draft.commits.delete(key);
            if (!draft.commits.size && !draft.discarding) drafts.delete(source);
          });
        }
        results.push(await entry.pending);
        report((index + 1) / paths.length);
      }
      return results;
    },
    async discardStagedAttachment({ path: source }) {
      const filename = localPath(source);
      if (!filename) return;
      const draft = draftFor(filename);
      if (!draft.discarding) {
        const entries = [...draft.commits.values()];
        for (const entry of entries) entry.controller.abort();
        // Wait for open upload handles to close before unlinking, including on Windows.
        draft.discarding = Promise.allSettled(entries.map(entry => entry.pending))
          .then(() => rm(filename, { force: true })).finally(() => drafts.delete(filename));
      }
      return draft.discarding;
    },
    // The original eager upload and image captioning target the cloud store.
    // Local Host attachments are committed to the execution node at send time.
    preuploadStagedAttachment: async () => {},
    releaseStagedAttachmentPreupload: async () => {},
    precaptionStagedAttachment: async () => {},
  };
  return { handlers, withStaged };
}
