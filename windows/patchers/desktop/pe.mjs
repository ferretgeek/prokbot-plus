import { crc32, deflateSync } from 'node:zlib';
// Minimal PE helpers for the original Windows executable: read the application icon,
// update Electron's embedded ASAR integrity value and remove the Authenticode
// signature that no longer matches once the executable has been modified.

const RT_ICON = 3, RT_GROUP_ICON = 14;

function headers(buffer) {
  if (buffer.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a PE executable');
  const pe = buffer.readUInt32LE(0x3c);
  if (buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE signature');
  const sectionCount = buffer.readUInt16LE(pe + 6), optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24, magic = buffer.readUInt16LE(optional);
  if (magic !== 0x20b) throw new Error('Only 64-bit PE executables are supported');
  const directories = optional + 112;
  const sections = [];
  for (let index = 0, at = optional + optionalSize; index < sectionCount; index++, at += 40)
    sections.push({ virtualAddress: buffer.readUInt32LE(at + 12), virtualSize: buffer.readUInt32LE(at + 8),
      rawOffset: buffer.readUInt32LE(at + 20), rawSize: buffer.readUInt32LE(at + 16) });
  return { optional, directories, sections };
}

function offsetOf(sections, rva) {
  const section = sections.find(item => rva >= item.virtualAddress && rva < item.virtualAddress + Math.max(item.virtualSize, item.rawSize));
  if (!section) throw new Error('Resource address outside the image');
  return section.rawOffset + rva - section.virtualAddress;
}

/** Map of resource type -> id -> data buffer (first language). */
function resources(buffer) {
  const { directories, sections } = headers(buffer);
  const rva = buffer.readUInt32LE(directories + 2 * 8);
  if (!rva) return new Map();
  const root = offsetOf(sections, rva);
  const entries = at => {
    const count = buffer.readUInt16LE(at + 12) + buffer.readUInt16LE(at + 14);
    return Array.from({ length: count }, (_, index) => {
      const entry = at + 16 + index * 8, name = buffer.readUInt32LE(entry), target = buffer.readUInt32LE(entry + 4);
      return { id: name & 0x80000000 ? null : name, directory: Boolean(target & 0x80000000), offset: root + (target & 0x7fffffff) };
    });
  };
  const result = new Map();
  for (const type of entries(root)) {
    if (!type.directory || type.id === null) continue;
    const items = new Map();
    for (const item of entries(type.offset)) {
      if (!item.directory) continue;
      const language = entries(item.offset).find(value => !value.directory);
      if (!language) continue;
      const dataRva = buffer.readUInt32LE(language.offset), size = buffer.readUInt32LE(language.offset + 4);
      const start = offsetOf(sections, dataRva);
      items.set(item.id ?? items.size, buffer.subarray(start, start + size));
    }
    result.set(type.id, items);
  }
  return result;
}

/** The first icon group as an .ico file and its largest PNG image. */
export function applicationIcon(buffer) {
  const all = resources(buffer), groups = all.get(RT_GROUP_ICON), icons = all.get(RT_ICON);
  if (!groups?.size || !icons) throw new Error('Executable has no application icon');
  const group = [...groups.values()][0], count = group.readUInt16LE(4);
  const images = Array.from({ length: count }, (_, index) => {
    const at = 6 + index * 14, id = group.readUInt16LE(at + 12);
    const data = icons.get(id);
    if (!data) throw new Error('Icon image is missing');
    return { header: group.subarray(at, at + 12), width: group[at] || 256, data };
  });
  const directory = Buffer.alloc(6 + count * 16);
  group.copy(directory, 0, 0, 6);
  let offset = directory.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    image.header.copy(directory, at, 0, 8);
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  const largest = [...images].sort((a, b) => b.width - a.width)[0];
  return { ico: Buffer.concat([directory, ...images.map(image => image.data)]),
    png: isPng(largest.data) ? largest.data : dibToPng(largest.data) };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const isPng = data => data.subarray(0, 8).equals(PNG_SIGNATURE);

/** Convert a 32-bit BGRA icon bitmap (bottom-up, XOR mask followed by AND mask) to PNG. */
function dibToPng(dib) {
  const headerSize = dib.readUInt32LE(0), width = dib.readInt32LE(4), height = dib.readInt32LE(8) / 2;
  const bits = dib.readUInt16LE(14), compression = dib.readUInt32LE(16);
  if (bits !== 32 || compression !== 0 || width <= 0 || height <= 0) throw new Error('Unsupported icon bitmap');
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const source = headerSize + (height - 1 - y) * stride, target = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      const at = source + x * 4, to = target + x * 4;
      raw[to] = dib[at + 2]; raw[to + 1] = dib[at + 1]; raw[to + 2] = dib[at]; raw[to + 3] = dib[at + 3];
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const INTEGRITY = /\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/g;

/** Replace Electron's embedded app.asar header hash (same length, in place). */
export function replaceAsarIntegrity(buffer, expected, replacement) {
  const text = buffer.toString('latin1');
  const matches = [...text.matchAll(INTEGRITY)];
  if (matches.length !== 1) throw new Error('Embedded ASAR integrity record not found');
  if (matches[0][1] !== expected) throw new Error('Embedded ASAR integrity does not match the original');
  if (!/^[0-9a-f]{64}$/.test(replacement)) throw new Error('Invalid ASAR header hash');
  const at = matches[0].index + matches[0][0].indexOf(expected);
  const output = Buffer.from(buffer);
  output.write(replacement, at, 'latin1');
  return output;
}

/** Remove the Authenticode certificate table; the checksum is cleared as it is not enforced for applications. */
export function stripAuthenticode(buffer) {
  const { optional, directories } = headers(buffer);
  const entry = directories + 4 * 8;
  const offset = buffer.readUInt32LE(entry), size = buffer.readUInt32LE(entry + 4);
  const output = Buffer.from(buffer);
  if (!offset || !size) return output;
  if (offset + size !== buffer.length) throw new Error('Certificate table is not at the end of the executable');
  output.writeUInt32LE(0, entry);
  output.writeUInt32LE(0, entry + 4);
  output.writeUInt32LE(0, optional + 64);
  // The table is 8-byte aligned after the image; any padding before it belongs to the image.
  return output.subarray(0, offset);
}

export function hasAuthenticode(buffer) {
  const { directories } = headers(buffer);
  return buffer.readUInt32LE(directories + 4 * 8 + 4) > 0;
}
