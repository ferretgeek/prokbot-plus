// APK assembly in plain Node.js: ZIP reading and aligned writing, a self-signed
// certificate, and APK Signature Scheme v2 (Android 7+; this client needs 9+).
// No JDK or Android SDK is required to build the client.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
const BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const V2_BLOCK_ID = 0x7109871a;
const CHUNK = 1024 * 1024;
// 1981-01-01 00:00, the timestamp Android's own build tools use for reproducible archives.
const DOS_DATE = ((1981 - 1980) << 9) | (1 << 5) | 1;

const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; };
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const prefixed = (...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length), body]); };

export function findEnd(buffer) {
  const lowest = Math.max(0, buffer.length - 0xffff - 22);
  for (let at = buffer.length - 22; at >= lowest; at--) {
    if (buffer.readUInt32LE(at) === END && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) return at;
  }
  throw new Error('Not a ZIP archive');
}

export function readZip(buffer) {
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let at = centralOffset, index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error('Corrupt ZIP central directory');
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error('Corrupt ZIP local header');
    const compressedSize = buffer.readUInt32LE(at + 20);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    entries.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      flags: buffer.readUInt16LE(at + 8), method: buffer.readUInt16LE(at + 10),
      time: buffer.readUInt16LE(at + 12), date: buffer.readUInt16LE(at + 14), crc: buffer.readUInt32LE(at + 16),
      compressedSize, size: buffer.readUInt32LE(at + 24), externalAttributes: buffer.readUInt32LE(at + 38),
      localOffset, dataStart, data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, centralOffset, end };
}

export function entryBytes(entry) {
  if (entry.method === 0) return Buffer.from(entry.data);
  if (entry.method === 8) return inflateRawSync(entry.data);
  throw new Error(`Unsupported ZIP compression in ${entry.name}`);
}

/** A new entry; compressed unless that does not help or the file must stay stored. */
export function createEntry(name, content, { store = false } = {}) {
  const bytes = Buffer.from(content);
  let method = 0, data = bytes;
  if (!store && bytes.length > 0) {
    const deflated = deflateRawSync(bytes, { level: 9 });
    if (deflated.length < bytes.length) { method = 8; data = deflated; }
  }
  return { name, flags: 0, method, time: 0, date: DOS_DATE, crc: crc32(bytes) >>> 0,
    compressedSize: data.length, size: bytes.length, externalAttributes: 0, data };
}

/**
 * Writes entries in order. Stored data starts on a 4-byte boundary (16 KiB for
 * native libraries), as zipalign does, using the 0xd935 alignment extra field.
 */
export function writeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const flags = /[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0;
    let extra = Buffer.alloc(0);
    if (entry.method === 0) {
      const alignment = entry.name.endsWith('.so') ? 16384 : 4;
      const padding = (alignment - ((offset + 30 + name.length + 6) % alignment)) % alignment;
      extra = Buffer.concat([u16(0xd935), u16(2 + padding), u16(alignment), Buffer.alloc(padding)]);
    }
    const version = entry.method === 8 ? 20 : 10;
    const fields = Buffer.concat([u16(version), u16(flags), u16(entry.method), u16(entry.time), u16(entry.date),
      u32(entry.crc), u32(entry.data.length), u32(entry.size), u16(name.length)]);
    parts.push(u32(LOCAL), fields, u16(extra.length), name, extra, entry.data);
    central.push(Buffer.concat([u32(CENTRAL), u16(version), fields, u16(0), u16(0), u16(0), u16(0),
      u32(entry.externalAttributes ?? 0), u32(offset), name]));
    offset += 30 + name.length + extra.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) throw new Error('APK too large');
  const end = Buffer.concat([u32(END), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, directory, end]);
}

function chunkedDigest(sections) {
  const digests = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += CHUNK) {
      const chunk = section.subarray(at, Math.min(section.length, at + CHUNK));
      digests.push(createHash('sha256').update(Buffer.from([0xa5])).update(u32(chunk.length)).update(chunk).digest());
    }
  }
  return createHash('sha256').update(Buffer.from([0x5a])).update(u32(digests.length)).update(Buffer.concat(digests)).digest();
}

const algorithmFor = key => {
  if (key.asymmetricKeyType === 'ec') return 0x0201; // ECDSA with SHA2-256
  if (key.asymmetricKeyType === 'rsa') return 0x0103; // RSASSA-PKCS1-v1_5 with SHA2-256
  throw new Error('Signing key must be EC P-256 or RSA');
};

/** Adds an APK Signature Scheme v2 block to an unsigned, aligned APK. */
export function signApk(unsigned, { privateKey, certificate }) {
  const end = findEnd(unsigned);
  const centralOffset = unsigned.readUInt32LE(end + 16);
  const contents = unsigned.subarray(0, centralOffset);
  const directory = unsigned.subarray(centralOffset, end);
  const tail = unsigned.subarray(end);
  if (contents.subarray(-16).equals(BLOCK_MAGIC)) throw new Error('APK is already signed');
  const algorithm = algorithmFor(privateKey);
  const digest = chunkedDigest([contents, directory, tail]);
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const signedData = Buffer.concat([
    prefixed(prefixed(u32(algorithm), prefixed(digest))),
    prefixed(prefixed(certificate)),
    prefixed(),
  ]);
  const signature = sign('sha256', signedData, privateKey);
  const signer = Buffer.concat([prefixed(signedData), prefixed(prefixed(u32(algorithm), prefixed(signature))), prefixed(publicKey)]);
  const value = prefixed(prefixed(signer));
  const pair = Buffer.concat([u64(4 + value.length), u32(V2_BLOCK_ID), value]);
  const size = pair.length + 8 + BLOCK_MAGIC.length;
  const block = Buffer.concat([u64(size), pair, u64(size), BLOCK_MAGIC]);
  const signedTail = Buffer.from(tail);
  signedTail.writeUInt32LE(centralOffset + block.length, 16);
  return Buffer.concat([contents, block, directory, signedTail]);
}

/** Checks a v2 signature the way Android does; returns the signer certificate. */
export function verifyApk(apk) {
  const end = findEnd(apk);
  const centralOffset = apk.readUInt32LE(end + 16);
  if (!apk.subarray(centralOffset - 16, centralOffset).equals(BLOCK_MAGIC)) throw new Error('No APK Signing Block');
  const size = Number(apk.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;
  if (blockStart < 0 || Number(apk.readBigUInt64LE(blockStart)) !== size) throw new Error('Corrupt APK Signing Block');
  let v2 = null;
  for (let at = blockStart + 8; at < centralOffset - 24;) {
    const length = Number(apk.readBigUInt64LE(at));
    if (apk.readUInt32LE(at + 8) === V2_BLOCK_ID) v2 = apk.subarray(at + 12, at + 8 + length);
    at += 8 + length;
  }
  if (!v2) throw new Error('No APK Signature Scheme v2 block');
  const read = (buffer, at) => { const length = buffer.readUInt32LE(at); return [buffer.subarray(at + 4, at + 4 + length), at + 4 + length]; };
  const [signers] = read(v2, 0);
  const [signer] = read(signers, 0);
  let at = 0, signedData, signatures, publicKeyDer;
  [signedData, at] = read(signer, at); [signatures, at] = read(signer, at); [publicKeyDer] = read(signer, at);
  const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const [signatureRecord] = read(signatures, 0);
  const algorithm = signatureRecord.readUInt32LE(0);
  const [signature] = read(signatureRecord, 4);
  if (!verify('sha256', signedData, publicKey, signature)) throw new Error('APK signature does not verify');
  let cursor = 0, digests, certificates;
  [digests, cursor] = read(signedData, cursor); [certificates] = read(signedData, cursor);
  const [digestRecord] = read(digests, 0);
  if (digestRecord.readUInt32LE(0) !== algorithm) throw new Error('Digest algorithm mismatch');
  const [digest] = read(digestRecord, 4);
  const tail = Buffer.from(apk.subarray(end));
  tail.writeUInt32LE(blockStart, 16);
  const expected = chunkedDigest([apk.subarray(0, blockStart), apk.subarray(centralOffset, end), tail]);
  if (!digest.equals(expected)) throw new Error('APK contents do not match the signature');
  const [certificate] = read(certificates, 0);
  const x509 = new X509Certificate(certificate);
  if (!x509.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKeyDer)) throw new Error('Certificate key mismatch');
  return x509;
}

// ---- self-signed certificate -----------------------------------------------------------------

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const der = (tag, ...content) => { const body = Buffer.concat(content); return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]); };
const sequence = (...content) => der(0x30, ...content);
const set = (...content) => der(0x31, ...content);
function objectId(text) {
  const parts = text.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let value = part >>> 7; value > 0; value >>>= 7) encoded.unshift((value & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
function integer(bytes) {
  let value = Buffer.from(bytes);
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return der(0x02, value);
}
function time(date) {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(text.slice(2))) : der(0x18, Buffer.from(text));
}
const name = (common, organization) => sequence(
  set(sequence(objectId('2.5.4.10'), der(0x0c, Buffer.from(organization)))),
  set(sequence(objectId('2.5.4.3'), der(0x0c, Buffer.from(common)))));

/** Creates the user's own signing identity: EC P-256 key and a 30-year self-signed certificate. */
export function createSigningIdentity({ commonName = 'Grok Bot Local', organization = 'ProkBot Plus', now = new Date() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = sequence(objectId('1.2.840.10045.4.3.2'));
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.UTC(now.getUTCFullYear() + 30, now.getUTCMonth(), now.getUTCDate()));
  const serial = randomBytes(16); serial[0] &= 0x7f;
  const tbs = sequence(der(0xa0, integer([2])), integer(serial), algorithm, name(commonName, organization),
    sequence(time(notBefore), time(notAfter)), name(commonName, organization),
    publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { privateKey, certificate };
}

export function certificateFingerprint(certificate) {
  return createHash('sha256').update(certificate).digest('hex').match(/../g).join(':').toUpperCase();
}
