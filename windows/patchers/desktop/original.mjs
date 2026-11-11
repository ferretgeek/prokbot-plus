// Reading the official Windows installer: shared by the Windows and Android patchers.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** The NSIS installer stores app-64.7z uncompressed; its own header gives the exact length. */
export async function carveSevenZip(setup, destination, expected, wrapper) {
  const bytes = await readFile(setup);
  if (wrapper && (bytes.length !== wrapper.bytes || sha(bytes) !== wrapper.sha256))
    throw new Error('官方安装包摘要不匹配。');
  const signature = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  for (let at = bytes.indexOf(signature); at >= 0; at = bytes.indexOf(signature, at + 1)) {
    if (at + 32 > bytes.length) break;
    const length = 32 + Number(bytes.readBigUInt64LE(at + 12)) + Number(bytes.readBigUInt64LE(at + 20));
    if (length !== expected.bytes || at + length > bytes.length) continue;
    const archive = bytes.subarray(at, at + length);
    if (sha(archive) !== expected.sha256) continue;
    await writeFile(destination, archive);
    return destination;
  }
  throw new Error('安装包中没有找到受支持的程序包。');
}

export async function unpackOriginal(source, temporary, supported) {
  if ((await stat(source)).isDirectory()) return source;
  const extension = path.extname(source).toLowerCase();
  let archive;
  if (extension === '.exe') {
    archive = await carveSevenZip(source, path.join(temporary, supported.payload.name), supported.payload, supported.archive);
  } else if (extension === '.7z') {
    archive = source;
    if ((await stat(source)).size !== supported.payload.bytes || sha(await readFile(source)) !== supported.payload.sha256)
      throw new Error('原版程序包摘要不匹配。');
  } else throw new Error('输入必须是官方 Windows 安装包、app-64.7z 或已安装的原版目录。');
  const app = path.join(temporary, 'original');
  await mkdir(app);
  extractSevenZip(archive, app);
  return app;
}

/**
 * Windows 11 ships bsdtar with 7z support; macOS tar is bsdtar too. Otherwise 7-Zip
 * (7z, 7za or 7zz) or libarchive's bsdtar is used when present.
 */
export function extractSevenZip(archive, directory) {
  const windows = process.platform === 'win32';
  const systemTar = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : null;
  const sevenZip = [process.env.GROKBOT_7Z, windows ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe') : null]
    .filter(Boolean).find(candidate => existsSync(candidate));
  const attempts = [
    ...(systemTar && existsSync(systemTar) ? [[systemTar, ['-xf', archive, '-C', directory]]] : []),
    ...(sevenZip ? [[sevenZip, ['x', '-y', `-o${directory}`, archive]]] : []),
    ...(windows ? [] : [
      ['bsdtar', ['-xf', archive, '-C', directory]],
      ...(process.platform === 'darwin' ? [['/usr/bin/tar', ['-xf', archive, '-C', directory]]] : []),
      ...['7zz', '7z', '7za'].map(command => [command, ['x', '-y', `-o${directory}`, archive]]),
    ]),
  ];
  for (const [command, argv] of attempts) {
    try { execFileSync(command, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); return; }
    catch { /* try the next extractor */ }
  }
  throw new Error(windows
    ? '无法解压原版程序包。请使用 Windows 11，或安装 7-Zip 后重试（也可设置 GROKBOT_7Z 指向 7z.exe）。'
    : '无法解压原版程序包。请安装 7-Zip（7zz/7z）或 libarchive 的 bsdtar 后重试，也可设置 GROKBOT_7Z。');
}
