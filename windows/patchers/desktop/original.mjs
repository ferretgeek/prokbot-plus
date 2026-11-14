// Reading the official Windows installer: shared by the Windows and Android patchers.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { snapshotPayload } from './snapshot-payload.mjs';
export { carveSevenZip } from './snapshot-payload.mjs';

export async function unpackOriginal(source, temporary, supported) {
  if ((await stat(source)).isDirectory()) return source;
  const work = await mkdtemp(path.join(temporary, 'original-'));
  try {
    const archive = await snapshotPayload(source, work, supported);
    return await extractSevenZip(archive, work);
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Windows 11 ships bsdtar with 7z support; macOS tar is bsdtar too. Otherwise 7-Zip
 * (7z, 7za or 7zz) or libarchive's bsdtar is used when present.
 */
async function extractSevenZip(archive, work) {
  const windows = process.platform === 'win32';
  const systemTar = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : null;
  const sevenZip = [process.env.GROKBOT_7Z, windows ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe') : null]
    .filter(Boolean).find(candidate => existsSync(candidate));
  const attempts = [
    ...(systemTar && existsSync(systemTar) ? [[systemTar, 'tar']] : []),
    ...(sevenZip ? [[sevenZip, '7z']] : []),
    ...(windows ? [] : [
      ['bsdtar', 'tar'],
      ...(process.platform === 'darwin' ? [['/usr/bin/tar', 'tar']] : []),
      ...['7zz', '7z', '7za'].map(command => [command, '7z']),
    ]),
  ];
  for (const [command, format] of attempts) {
    const directory = await mkdtemp(path.join(work, 'app-'));
    const argv = format === 'tar' ? ['-xf', archive, '-C', directory] : ['x', '-y', `-o${directory}`, archive];
    try { execFileSync(command, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); return directory; }
    catch { await rm(directory, { recursive: true, force: true }); }
  }
  throw new Error(windows
    ? '无法解压原版程序包。请使用 Windows 11，或安装 7-Zip 后重试（也可设置 GROKBOT_7Z 指向 7z.exe）。'
    : '无法解压原版程序包。请安装 7-Zip（7zz/7z）或 libarchive 的 bsdtar 后重试，也可设置 GROKBOT_7Z。');
}
