import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const LC_UUID = 0x1b;
const uuidText = bytes => {
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-').toUpperCase();
};

function slices(bytes) {
  if (bytes.length < 8) throw new Error('Truncated Mach-O executable');
  if (bytes.readUInt32BE(0) !== 0xcafebabe) return [{ offset: 0, size: bytes.length }];
  const count = bytes.readUInt32BE(4);
  if (!count || count > 16 || 8 + count * 20 > bytes.length) throw new Error('Invalid Mach-O architecture table');
  const result = [];
  for (let index = 0; index < count; index++) {
    const at = 8 + index * 20, offset = bytes.readUInt32BE(at + 8), size = bytes.readUInt32BE(at + 12);
    if (offset < 8 + count * 20 || size < 32 || offset + size > bytes.length ||
        result.some(item => offset < item.offset + item.size && item.offset < offset + size))
      throw new Error('Invalid Mach-O architecture range');
    result.push({ offset, size });
  }
  return result;
}

/** Keep a variant's executable identity stable across rebuilds and distinct from the original app. */
export async function patchBundleExecutableUuid(filename, bundleId) {
  if (typeof bundleId !== 'string' || !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(bundleId))
    throw new Error('Invalid bundle identity for Mach-O UUID');
  const bytes = await readFile(filename), changes = [];
  for (const { offset, size } of slices(bytes)) {
    if (size < 32 || bytes.readUInt32LE(offset) !== 0xfeedfacf) throw new Error('Expected a 64-bit Mach-O executable');
    const cpuType = bytes.readUInt32LE(offset + 4), cpuSubtype = bytes.readUInt32LE(offset + 8);
    const count = bytes.readUInt32LE(offset + 16), commandsSize = bytes.readUInt32LE(offset + 20);
    const end = offset + 32 + commandsSize;
    if (!count || count > commandsSize / 8 || end > offset + size) throw new Error('Invalid Mach-O load commands');
    let at = offset + 32, uuidAt;
    for (let index = 0; index < count; index++) {
      if (at + 8 > end) throw new Error('Truncated Mach-O load command');
      const command = bytes.readUInt32LE(at), length = bytes.readUInt32LE(at + 4);
      if (length < 8 || length % 4 || at + length > end) throw new Error('Invalid Mach-O load command size');
      if (command === LC_UUID) {
        if (uuidAt !== undefined || length !== 24) throw new Error('Invalid or duplicate Mach-O UUID');
        uuidAt = at + 8;
      }
      at += length;
    }
    if (at !== end || uuidAt === undefined) throw new Error('Missing Mach-O UUID or incomplete load commands');
    const original = bytes.subarray(uuidAt, uuidAt + 16);
    // UUIDv5: the original build UUID is the namespace; the bundle and CPU identify the variant.
    const replacement = createHash('sha1').update(original).update(`ProkBot/macOS/${bundleId}/${cpuType}/${cpuSubtype}`).digest().subarray(0, 16);
    replacement[6] = (replacement[6] & 0x0f) | 0x50;
    replacement[8] = (replacement[8] & 0x3f) | 0x80;
    changes.push({ offset: uuidAt, bytes: replacement, cpuType, before: uuidText(original), after: uuidText(replacement) });
  }
  // Validate every architecture before changing any bytes on disk. Signing happens afterwards.
  for (const change of changes) change.bytes.copy(bytes, change.offset);
  await writeFile(filename, bytes);
  return changes.map(({ cpuType, before, after }) => ({ cpuType, before, after }));
}
