import { entryBytes } from './apk.mjs';

const NONE = 0xffffffff;
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const invalid = detail => { throw new Error(`Invalid AndroidManifest.xml: ${detail}`); };

function chunkAt(bytes, at) {
  if (at + 8 > bytes.length) invalid('truncated chunk');
  const type = bytes.readUInt16LE(at), header = bytes.readUInt16LE(at + 2), size = bytes.readUInt32LE(at + 4);
  if (header < 8 || header > size || at + size > bytes.length) invalid('invalid chunk size');
  return { type, header, bytes: bytes.subarray(at, at + size) };
}

function stringReader({ header, bytes }) {
  if (header < 28) invalid('truncated string pool');
  const count = bytes.readUInt32LE(8), styles = bytes.readUInt32LE(12);
  const utf8 = (bytes.readUInt32LE(16) & 0x100) !== 0, width = utf8 ? 1 : 2;
  const start = bytes.readUInt32LE(20), end = bytes.readUInt32LE(24) || bytes.length;
  if (header + 4 * (count + styles) > start || start > end || end > bytes.length) invalid('invalid string pool');
  return index => {
    if (index >= count) invalid('invalid string index');
    let at = start + bytes.readUInt32LE(header + index * 4);
    const unit = () => {
      if (at + width > end) invalid('truncated string');
      const value = bytes.readUIntLE(at, width);
      at += width;
      return value;
    };
    const length = () => {
      const first = unit(), flag = utf8 ? 0x80 : 0x8000;
      return first < flag ? first : (first - flag) * (utf8 ? 256 : 65536) + unit();
    };
    if (utf8) length(); // UTF-8 pools prefix the byte length with the UTF-16 character count.
    const size = length() * width;
    if (at + size + width > end || bytes.readUIntLE(at + size, width) !== 0) invalid('unterminated string');
    return bytes.toString(utf8 ? 'utf8' : 'utf16le', at, at + size);
  };
}

// Only the root manifest's typed attributes count. Matching a string elsewhere in the APK is not evidence of its version.
export function readShellManifest(entries) {
  const manifests = entries.filter(e => e.name === 'AndroidManifest.xml');
  if (manifests.length !== 1) invalid('expected exactly one manifest');
  const xml = entryBytes(manifests[0]), document = chunkAt(xml, 0);
  if (document.type !== 0x0003 || document.bytes.length !== xml.length) invalid('expected binary XML');
  let string, ids;
  for (let at = document.header; at < xml.length;) {
    const chunk = chunkAt(xml, at), { type, header, bytes } = chunk;
    at += bytes.length;
    if (type === 0x0001) string = stringReader(chunk);
    if (type === 0x0180) ids = bytes.subarray(header); // Android resource IDs indexed by attribute name.
    if (type !== 0x0102) continue;
    if (!string || !ids || header < 16 || header + 20 > bytes.length || bytes.readUInt32LE(header) !== NONE ||
        string(bytes.readUInt32LE(header + 4)) !== 'manifest') invalid('expected manifest root');
    const start = header + bytes.readUInt16LE(header + 8), stride = bytes.readUInt16LE(header + 10);
    const count = bytes.readUInt16LE(header + 12), result = {};
    if (start < header + 20 || stride < 20 || start + count * stride > bytes.length) invalid('invalid attribute table');
    for (let i = 0; i < count; i++) {
      const pos = start + i * stride, ns = bytes.readUInt32LE(pos), name = bytes.readUInt32LE(pos + 4);
      const id = (name + 1) * 4 <= ids.length ? ids.readUInt32LE(name * 4) : 0;
      let key;
      if (ns === NONE && string(name) === 'package') key = 'packageName';
      else if (ns !== NONE && string(ns) === ANDROID_NS) {
        if (id === 0x0101021b) key = 'versionCode';
        if (id === 0x0101021c) key = 'versionName';
      }
      if (!key) continue;
      const valueType = bytes[pos + 15], data = bytes.readUInt32LE(pos + 16);
      if (Object.hasOwn(result, key) || bytes.readUInt16LE(pos + 12) !== 8) invalid(`invalid ${key}`);
      if (key === 'versionCode' && (valueType === 0x10 || valueType === 0x11)) result[key] = data;
      else if (key !== 'versionCode' && valueType === 0x03) result[key] = string(data);
      else invalid(`expected a literal ${key}`);
    }
    if (!result.packageName || !result.versionName || !result.versionCode) invalid('missing package or version');
    return result;
  }
  invalid('missing manifest root');
}

const label = shell => `${shell.versionName} (versionCode ${shell.versionCode})`;

export function verifyShellVersion(entries, expected) {
  const actual = readShellManifest(entries);
  if (actual.packageName !== 'dev.grokbot.local') throw new Error(`Unexpected Android shell package: ${actual.packageName}`);
  if (actual.versionName !== expected.versionName || actual.versionCode !== expected.versionCode)
    throw new Error(`Android shell version mismatch: APK ${label(actual)}, expected ${label(expected)}. Rebuild the project shell.`);
  return actual;
}

export function verifyClientVersions(entries, build) {
  const actual = verifyShellVersion(entries, build.shell);
  const records = entries.filter(entry => entry.name === 'assets/web/client/build.json');
  if (records.length !== 1) throw new Error('Expected exactly one Android client build record.');
  const record = JSON.parse(entryBytes(records[0]).toString('utf8'));
  if (record.shell?.versionName !== actual.versionName || record.shell.versionCode !== actual.versionCode ||
      record.rendererVersion !== build.desktopVersion) throw new Error('Android client build record version mismatch.');
  return actual;
}

export function checkVersionAdvance(previous, next) {
  if (next.versionCode < previous.versionCode || (next.versionName !== previous.versionName && next.versionCode === previous.versionCode))
    throw new Error(`Android shell versionCode must increase for a new release: ${label(previous)} -> ${label(next)}`);
}
