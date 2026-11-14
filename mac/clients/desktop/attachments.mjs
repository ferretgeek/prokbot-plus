import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokText } from './i18n.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const PREVIEW_BYTES = 25 * 1024 * 1024;
const TEXT_HEAD_BYTES = 6 * 1024 * 1024;

// These are remote Host paths, never files to open on the client's filesystem.
// The Host runs on Linux, so file URLs use POSIX rules even when this client runs on Windows.
export function remoteAttachmentPath(source) {
  if (typeof source !== 'string' || !source || source.includes('\0')) return null;
  if (/^file:/i.test(source)) {
    try { return fileURLToPath(source, { windows: false }); } catch { return null; }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(source) ? null : source;
}

function totalSize(chunk) {
  if (!Number.isSafeInteger(chunk?.totalSize) || chunk.totalSize < 0)
    throw new Error(grokText('附件大小无效。', 'Invalid attachment size.'));
  return chunk.totalSize;
}

export function createAttachmentMediaResolver({ command, withStaged, nativeImage }) {
  return async ({ source, rendition }) => {
    const staged = await withStaged(source, async (file, size) => {
      if (size > PREVIEW_BYTES) throw new Error(grokText('附件过大，无法预览。', 'Attachment is too large to preview.'));
      return nativeImage.createFromBuffer(await localChunk(file, 0, size));
    });
    const remote = remoteAttachmentPath(source);
    if (!staged && remote === null) throw new Error('Invalid attachment path');
    const result = staged ? { dataUrl: staged.toDataURL() }
      : await command('readAttachmentImage', { path: remote,
        rendition: rendition === 'original' ? 'original' : 'preview' }, AbortSignal.timeout(30000));
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(result?.dataUrl)) throw new Error('Unsupported attachment');
    const image = staged ?? nativeImage.createFromDataURL(result.dataUrl);
    if (image.isEmpty()) throw new Error('Invalid image attachment');
    const size = image.getSize();
    const width = Number(/^tile-(\d+)$/.exec(rendition ?? '')?.[1]);
    return { kind: 'image', src: width && size.width > width ? image.resize({ width }).toDataURL() : result.dataUrl, ...size };
  };
}

async function localChunk(file, offset, length) {
  const bytes = Buffer.alloc(length);
  for (let done = 0; done < length;) {
    const { bytesRead } = await file.read(bytes, done, length - done, offset + done);
    if (!bytesRead) throw new Error('Staged attachment changed');
    done += bytesRead;
  }
  return bytes;
}

export function createAttachmentHandlers({ command, chooseDestination, showDownloadError, withStaged = async () => null }) {
  const request = (method, args) => command(method, args, AbortSignal.timeout(30000));
  const scope = ({ path: source, agentId }) => {
    const value = remoteAttachmentPath(source);
    return value === null ? null : { path: value, ...(agentId ? { agentId } : {}) };
  };
  async function readChunk(args, offset, length, expectedSize) {
    const chunk = await request('readAttachmentChunk', { ...args, offset, length });
    if (chunk === null) return null;
    if (totalSize(chunk) !== expectedSize || typeof chunk.bytesBase64 !== 'string')
      throw new Error(grokText('附件已改变，请重试。', 'The attachment changed. Try again.'));
    const bytes = Buffer.from(chunk.bytesBase64, 'base64');
    if (bytes.length === 0 || bytes.length > length)
      throw new Error(grokText('附件读取不完整，请重试。', 'Incomplete attachment. Try again.'));
    return bytes;
  }
  async function saveDownload(size, name, read) {
    const destination = await chooseDestination(path.basename(name));
    if (!destination) return false;
    const temporary = path.join(path.dirname(destination), `.grokbot-download-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        for (let offset = 0; offset < size;) {
          const bytes = await read(offset, Math.min(CHUNK_BYTES, size - offset));
          if (bytes === null) throw new Error('Attachment not found');
          await file.writeFile(bytes);
          offset += bytes.length;
        }
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, destination);
      return true;
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return {
    async readAttachmentText(input) {
      const staged = await withStaged(input.path, async (file, size) => ({ kind: 'text',
        text: (await localChunk(file, 0, Math.min(size, TEXT_HEAD_BYTES))).toString('utf8'),
        bytes: size, truncated: size > TEXT_HEAD_BYTES }));
      if (staged !== null) return staged;
      const args = scope(input);
      return args === null ? null : request('readAttachmentText', args);
    },
    async readAttachmentBytes(input) {
      const maxBytes = Number.isFinite(input.maxBytes) && input.maxBytes > 0
        ? Math.min(Math.floor(input.maxBytes), PREVIEW_BYTES) : PREVIEW_BYTES;
      const staged = await withStaged(input.path, async (file, size) => {
        if (size > maxBytes) return { kind: 'too-large', size };
        const text = /\.(?:md|markdown|txt|text)$/i.test(input.path);
        const bytes = await localChunk(file, 0, text ? Math.min(size, TEXT_HEAD_BYTES) : size);
        return { kind: 'bytes', bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), size };
      });
      if (staged !== null) return staged;
      const args = scope(input);
      if (args === null) return null;
      const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
      if (info === null) return null;
      const size = totalSize(info);
      const name = info.resolvedName ? { resolvedName: info.resolvedName } : {};
      if (size > maxBytes) return { kind: 'too-large', size, ...name };
      const text = /\.(?:md|markdown|txt|text)$/i.test(info.resolvedName ?? args.path);
      const bytes = new Uint8Array(Math.min(size, text ? TEXT_HEAD_BYTES : maxBytes));
      for (let offset = 0; offset < bytes.length;) {
        const chunk = await readChunk(args, offset, Math.min(CHUNK_BYTES, bytes.length - offset), size);
        if (chunk === null) return null;
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { kind: 'bytes', bytes, size, ...name };
    },
    async downloadAttachment(input) {
      try {
        const local = await withStaged(input.path, (file, size) => saveDownload(size, input.suggestedName || input.path,
          (offset, length) => localChunk(file, offset, length)));
        if (local !== null) return local;
        const args = scope(input);
        if (args === null) throw new Error('Invalid attachment path');
        const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
        if (info === null) throw new Error('Attachment not found');
        const size = totalSize(info);
        return await saveDownload(size, input.suggestedName || info.resolvedName || args.path,
          (offset, length) => readChunk(args, offset, length, size));
      } catch (error) {
        console.error('[attachment-download]', error.message);
        await showDownloadError();
        return false;
      }
    },
  };
}
