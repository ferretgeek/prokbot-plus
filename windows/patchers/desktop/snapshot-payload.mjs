import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeNewFile } from './output.mjs';

const signature = Buffer.from('377abcaf271c', 'hex');

async function matchesPin(source, pin, range, output) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(source, range)) {
    bytes += chunk.length;
    if (bytes > pin.bytes) return false;
    hash.update(chunk);
    if (output) await output.writeFile(chunk);
  }
  return bytes === pin.bytes && hash.digest('hex') === pin.sha256;
}

async function copyPinned(source, destination, pin, label, range) {
  await writeNewFile(destination, async output => {
    if (!await matchesPin(source, pin, range, output)) throw new Error(`${label}摘要不匹配。`);
  });
  return destination;
}

// Only this prefix can contain a complete payload. Carry 31 bytes for a header split across reads.
async function* payloadOffsets(source, size, payloadBytes) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 32 || payloadBytes > size) return;
  let offset = 0, carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(source, { end: size - payloadBytes + 31 })) {
    const bytes = Buffer.concat([carry, chunk]), base = offset - carry.length;
    for (let i = bytes.indexOf(signature); i >= 0 && i + 32 <= bytes.length; i = bytes.indexOf(signature, i + 1)) {
      const length = 32n + bytes.readBigUInt64LE(i + 12) + bytes.readBigUInt64LE(i + 20);
      if (length === BigInt(payloadBytes)) yield base + i;
    }
    offset += chunk.length;
    carry = bytes.subarray(Math.max(0, bytes.length - 31));
  }
}

async function carvePayload(source, destination, expected, size) {
  for await (const start of payloadOffsets(source, size, expected.bytes)) {
    const range = { start, end: start + expected.bytes - 1 };
    if (await matchesPin(source, expected, range)) return copyPinned(source, destination, expected, '原版程序包', range);
  }
  throw new Error('安装包中没有找到受支持的程序包。');
}

/** The legacy carving API accepts a payload-only pin; production installers always supply both pins. */
export async function carveSevenZip(setup, destination, expected, wrapper) {
  const { size } = await stat(setup);
  if (!wrapper) return carvePayload(setup, destination, expected, size);
  if (size !== wrapper.bytes) throw new Error('官方安装包摘要不匹配。');
  const scratch = await mkdtemp(path.join(path.dirname(destination), '.grokbot-wrapper-'));
  try {
    // Inspect only the private copy whose complete bytes matched, not a possibly changed source path.
    const verified = await copyPinned(setup, path.join(scratch, 'installer.exe'), wrapper, '官方安装包');
    return await carvePayload(verified, destination, expected, size);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function snapshotPayload(source, scratch, supported) {
  const destination = path.join(scratch, 'payload.7z');
  switch (path.extname(source).toLowerCase()) {
    case '.exe':
      if (!supported.archive) throw new Error('缺少官方安装包的完整摘要。');
      return carveSevenZip(source, destination, supported.payload, supported.archive);
    case '.7z':
      if ((await stat(source)).size !== supported.payload.bytes) throw new Error('原版程序包摘要不匹配。');
      return copyPinned(source, destination, supported.payload, '原版程序包');
    default:
      throw new Error('输入必须是官方 Windows 安装包、app-64.7z 或已安装的原版目录。');
  }
}
