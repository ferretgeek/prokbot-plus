// Minimal deflate zip writer (no zip64): one archive serves as the portable download
// and as the installer payload.
import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import { once } from 'node:events';
import path from 'node:path';

const LIMIT = 0xffffffff;

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function files(root, relative = '') {
  const result = [];
  const entries = (await readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported file type: ${name}`);
  }
  return result;
}

/** Write every file below `directory` under `prefix/`; returns { bytes, entries }. */
export async function writeZip(directory, destination, { prefix, comment = '' }) {
  const output = createWriteStream(destination, { flags: 'wx' });
  let offset = 0;
  const write = async buffer => {
    offset += buffer.length;
    if (!output.write(buffer)) await once(output, 'drain');
  };
  const central = [];
  try {
    for (const relative of await files(directory)) {
      const filename = path.join(directory, ...relative.split('/'));
      const [data, info] = await Promise.all([readFile(filename), stat(filename)]);
      const deflated = deflateRawSync(data, { level: 6 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const name = Buffer.from(`${prefix}/${relative}`, 'utf8');
      if (data.length >= LIMIT || offset >= LIMIT) throw new Error('Archive exceeds the zip size limit');
      const { time, day } = dosTime(info.mtime), checksum = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12);
      local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      central.push({ name, stored, time, day, checksum, compressed: body.length, size: data.length, offset });
      await write(local); await write(name); await write(body);
    }
    const start = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(entry.stored ? 0 : 8, 10);
      header.writeUInt16LE(entry.time, 12); header.writeUInt16LE(entry.day, 14); header.writeUInt32LE(entry.checksum, 16);
      header.writeUInt32LE(entry.compressed, 20); header.writeUInt32LE(entry.size, 24); header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await write(header); await write(entry.name);
    }
    const note = Buffer.from(comment, 'utf8');
    if (central.length >= 0xffff || offset >= LIMIT || note.length >= 0xffff) throw new Error('Archive exceeds the zip limits');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); end.writeUInt16LE(note.length, 20);
    await write(end); await write(note);
  } finally {
    output.end();
    await once(output, 'close');
  }
  return { bytes: offset, entries: central.length };
}
