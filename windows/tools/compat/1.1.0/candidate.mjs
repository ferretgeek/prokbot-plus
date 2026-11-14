// Read only the selected packed members of the coordinator-verified input.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { getRawHeader } from '../../../../mac/patchers/desktop/node_modules/@electron/asar/lib/asar.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = Object.freeze({ platform: 'windows', version: '1.1.0', archiveBytes: 57252462,
  archiveSha256: 'ae8f0a14fe65f421881f96fdcb66aaaaed8b28806f79d5239dbefec9ef2ea972',
  headerBytes: 245816, headerSha256: '9fb5f015b88ae9ae5da2033aa1c447b6ea57c26a53bf04bf56b4f4219d4baa6a' });
export const members = Object.freeze({
  preload: ['dist/electron-preload/preload.cjs', '3204c8744260d6070dcffe2192b184bc6cdc9cb5d881d73e8b30c3517e91dac9'],
  library: ['dist/renderer/assets/chunk-bot-store-files-library-Cx0SHaX-.js', '60a38f710b8d068949ba7483e745d540077cc6f35a0fdf3fc6c54580eab15885'],
  empty: ['dist/renderer/assets/chunk-plugin-detail-sharepoint-write-Djmzxo8M.js', '4caaa8d32735ecf7950633c063e143b9c02413017b83ac72f2e97423c60fca8f'],
});

export function researchInput(platform = 'windows') {
  if (platform === 'windows') return { identity, members };
  assert.equal(platform, 'mac');
  return { identity: { platform, version: '1.1.0', archiveBytes: 57297508,
    archiveSha256: '2ce3b335f3d92c7be6ad59da397f8f6bf16c6d29474041ec5cc1e508b65b8e48',
    headerBytes: 246400, headerSha256: '8eb95ee4e7cf58eaaf6c0e54434ceb887cc4ac2b72920da5c2eed25705cf2f5b' }, members: {
    library: ['dist/renderer/assets/chunk-bot-store-files-library-OcCbwi0W.js', 'd52fc853966e3c3fd8a8f2349af04401d618a6489dcb5da2b2074dc15b468edb'],
    empty: ['dist/renderer/assets/chunk-plugin-detail-sharepoint-write-OvP2TX9_.js', '8447980f449b88d72d899ca68ac34647902db1dc30358c014e6a11855c1abea4'],
  } };
}

export function withCandidate(file, callback, platform = 'windows') {
  const { identity, members } = researchInput(platform);
  const fd = openSync(file, 'r');
  try {
    assert.equal(fstatSync(fd).size, identity.archiveBytes, 'unexpected archive size');
    const prefix = Buffer.alloc(8);
    assert.equal(readSync(fd, prefix, 0, 8, 0), 8);
    assert.equal(prefix.readUInt32LE(4), identity.headerBytes, 'unexpected header size');
    const { header, headerSize, headerString } = getRawHeader(file);
    assert.equal(headerSize, identity.headerBytes);
    assert.equal(sha(headerString), identity.headerSha256, 'archive header digest mismatch');
    const cache = new Map();
    function read(role) {
      assert.ok(Object.hasOwn(members, role), 'member not selected for this investigation');
      if (cache.has(role)) return cache.get(role);
      const [name, digest] = members[role];
      const info = name.split('/').reduce((entry, part) => entry?.files?.[part], header);
      assert.ok(info && !info.files && !info.link && !info.unpacked && info.integrity?.algorithm === 'SHA256', 'must be a hashed packed file');
      assert.equal(info.integrity.hash, digest);
      assert.ok(Number.isSafeInteger(info.size) && info.size > 0 && info.size <= 200 * 1024);
      assert.match(info.offset, /^\d+$/);
      const start = 8 + headerSize + Number(info.offset);
      assert.ok(Number.isSafeInteger(start) && start + info.size <= identity.archiveBytes);
      const bytes = Buffer.alloc(info.size);
      assert.equal(readSync(fd, bytes, 0, bytes.length, start), info.size, 'short archive member read');
      assert.equal(sha(bytes), digest, 'archive member digest mismatch');
      cache.set(role, bytes);
      return bytes;
    }
    function packed(name) {
      const node = name.split('/').reduce((entry, part) => entry?.files?.[part], header);
      return Boolean(node && !node.files && !node.link && !node.unpacked && node.integrity?.algorithm === 'SHA256');
    }
    return callback(read, packed);
  } finally { closeSync(fd); }
}
