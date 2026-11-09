#!/usr/bin/env node
// Build the Windows x64 client from the official Grok Bot installer: verify the
// pinned original, replace the main process with the local client, apply the
// Windows recipes, repack, record the new ASAR integrity in the executable and
// produce a portable folder, a portable zip and a per-user installer.
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, cp, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyReleaseRecipes } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { extractNotificationPolicy } from '../../../mac/patchers/desktop/extract-policy.mjs';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { applicationIcon, replaceAsarIntegrity, stripAuthenticode } from './pe.mjs';
import { writeZip } from './zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowsRoot = path.resolve(here, '../..');
const repo = path.resolve(windowsRoot, '..');
const supported = JSON.parse(await readFile(path.join(here, 'supported.json'), 'utf8'));
const APP = 'Grok Bot Local', EXE = 'Grok Bot.exe';
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (args.includes('--help')) {
  console.log(`node windows/patchers/desktop/patch.mjs [--source <Grok_Bot_${supported.version}_Setup.exe | app-64.7z | 安装目录>] [--output <目录>] [--no-installer] [--verify-only]
省略 --source 时自动下载并校验 ${supported.version} Windows x64 原版。默认输出到 windows/output/。`);
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('Windows 客户端需要在 Windows 上生成。');
const startedAt = performance.now();
const outputRoot = path.resolve(arg('--output') ?? path.join(windowsRoot, 'output'));
const appOutput = path.join(outputRoot, APP);
const portableZip = path.join(outputRoot, `GrokBotLocal-${supported.version}-x64-portable.zip`);
const setupExe = path.join(outputRoot, `GrokBotLocal-${supported.version}-x64-Setup.exe`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
const exists = async filename => { try { await stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

/** The NSIS installer stores app-64.7z uncompressed; its own header gives the exact length. */
export async function carveSevenZip(setup, destination, expected) {
  const bytes = await readFile(setup);
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

/** Windows 11 ships bsdtar with 7z support; 7-Zip is used when present or required. */
function extractSevenZip(archive, directory) {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const sevenZip = [process.env.GROKBOT_7Z, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe')]
    .filter(Boolean).find(candidate => existsSync(candidate));
  const attempts = [
    ...(existsSync(tar) ? [[tar, ['-xf', archive, '-C', directory]]] : []),
    ...(sevenZip ? [[sevenZip, ['x', '-y', `-o${directory}`, archive]]] : []),
  ];
  for (const [command, argv] of attempts) {
    try { execFileSync(command, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); return; }
    catch { /* try the next extractor */ }
  }
  throw new Error('无法解压原版程序包。请使用 Windows 11，或安装 7-Zip 后重试（也可设置 GROKBOT_7Z 指向 7z.exe）。');
}

function unpackedFiles(header, prefix = '') {
  const result = [];
  for (const [name, entry] of Object.entries(header.files ?? {})) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (entry.files) result.push(...unpackedFiles(entry, relative));
    else if (entry.unpacked) result.push(relative);
  }
  return result;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'grokbot-windows-patch-'));
const created = [];
try {
  const source = await acquireDesktopSource({ source: arg('--source'), cacheDirectory: path.join(windowsRoot, '.cache'), supported,
    onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Windows x64…`) });
  let app;
  if ((await stat(source)).isDirectory()) app = source;
  else {
    const extension = path.extname(source).toLowerCase();
    if (!['.exe', '.7z'].includes(extension)) throw new Error('输入必须是原版安装包、app-64.7z 或已安装的程序目录。');
    const archive = extension === '.7z' ? source : await carveSevenZip(source, path.join(temporary, supported.payload.name), supported.payload);
    if (await hashFile(archive) !== supported.payload.sha256) throw new Error('原版程序包摘要不匹配。');
    app = path.join(temporary, 'original');
    await mkdir(app);
    extractSevenZip(archive, app);
  }
  const originalExe = path.join(app, EXE), originalAsar = path.join(app, 'resources/app.asar');
  const [exeSha256, asarSha256] = await Promise.all([hashFile(originalExe), hashFile(originalAsar)]);
  if (exeSha256 !== supported.exeSha256 || asarSha256 !== supported.asarSha256)
    throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} Windows ${supported.architecture}；程序或 ASAR 摘要不匹配。`);
  console.log(JSON.stringify({ verified: true, version: supported.version, architecture: supported.architecture, asarSha256 }));
  if (args.includes('--verify-only')) process.exit(0);
  for (const target of [appOutput, portableZip, ...(args.includes('--no-installer') ? [] : [setupExe])])
    if (await exists(target)) throw new Error(`输出已存在，不会覆盖：${target}`);
  let asar;
  try { asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar'); }
  catch { throw new Error('缺少 @electron/asar；执行 npm install --prefix mac/patchers/desktop。'); }

  await mkdir(outputRoot, { recursive: true });
  await cp(app, appOutput, { recursive: true }); created.push(appOutput);
  const unpacked = path.join(temporary, 'app');
  asar.extractAll(originalAsar, unpacked);
  const originalUnpacked = new Set(unpackedFiles(asar.getRawHeader(originalAsar).header));
  const notificationPolicy = await extractNotificationPolicy(unpacked, here);
  const pkgPath = path.join(unpacked, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.version !== supported.version) throw new Error('ASAR 包版本不一致。');
  const previousMain = pkg.main;
  pkg.main = 'local-client/main.mjs';
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  const clients = path.join(repo, 'mac/clients');
  await cp(path.join(clients, 'desktop'), path.join(unpacked, 'local-client'), { recursive: true,
    filter: filename => path.basename(filename) !== 'notification-policy.mjs' });
  await writeFile(path.join(unpacked, 'local-client/notification-policy.mjs'), notificationPolicy);
  await cp(path.join(clients, 'shared'), path.join(unpacked, 'shared'), { recursive: true });
  const icon = applicationIcon(await readFile(originalExe));
  await writeFile(path.join(unpacked, 'local-client/icon.png'), icon.png);
  await writeFile(path.join(unpacked, 'local-client/icon.ico'), icon.ico);
  const patchStarted = performance.now();
  await applyReleaseRecipes(unpacked, path.join(here, 'recipes'));
  const patchSeconds = Number(((performance.now() - patchStarted) / 1000).toFixed(3));

  const outAsar = path.join(appOutput, 'resources/app.asar');
  await rm(outAsar);
  await rm(`${outAsar}.unpacked`, { recursive: true, force: true });
  await asar.createPackageWithOptions(unpacked, outAsar, {
    unpack: '{**/*.node,**/dist/native/**,**/dist/deps/**,**/onepassword-connection-service.cjs}' });
  // Native modules, helpers and their loaders stay outside the archive exactly as shipped.
  const patchedUnpacked = new Set(unpackedFiles(asar.getRawHeader(outAsar).header));
  const missing = [...originalUnpacked].filter(name => !patchedUnpacked.has(name));
  const extra = [...patchedUnpacked].filter(name => !originalUnpacked.has(name));
  if (missing.length || extra.length) throw new Error(`解包文件与原版不一致：${[...missing, ...extra].slice(0, 5).join(', ')}`);
  const headerSha256 = sha(asar.getRawHeader(outAsar).headerString);

  // The executable embeds the expected ASAR header hash; its Authenticode signature
  // cannot survive that change and is removed rather than left invalid.
  const exePath = path.join(appOutput, EXE);
  const exe = stripAuthenticode(replaceAsarIntegrity(await readFile(exePath), supported.asarHeaderSha256, headerSha256));
  await writeFile(exePath, exe);
  await cp(path.join(windowsRoot, 'dist/network/grokbot-tailcat.exe'), path.join(appOutput, 'resources/grokbot-tailcat.exe'));
  await cp(path.join(repo, 'mac/network/TAILCAT-LICENSE'), path.join(appOutput, 'resources/TAILCAT-LICENSE'));
  if (await hashFile(originalAsar) !== asarSha256) throw new Error('原版文件意外变化。');

  const manifest = { patchedAt: new Date().toISOString(), source, output: appOutput, version: supported.version,
    architecture: supported.architecture, originalAsarSha256: asarSha256, patchedAsarSha256: await hashFile(outAsar),
    asarHeaderSha256: headerSha256, originalEntry: previousMain, patchedEntry: pkg.main, appUserModelId: 'dev.grokbot.local',
    executable: { originalSha256: exeSha256, patchedSha256: sha(exe), signature: 'removed' },
    profile: '%APPDATA%\\Grok Bot Local', automaticUpdates: false, computerUse: 'unavailable on Windows',
    unpackedFiles: patchedUnpacked.size, timings: { patchSeconds } };
  await writeFile(path.join(appOutput, 'resources/grokbot-local.patch.json'), JSON.stringify(manifest, null, 2));

  created.push(portableZip);
  const zip = await writeZip(appOutput, portableZip, { prefix: APP, comment: supported.version });
  manifest.portableZip = { path: portableZip, bytes: zip.bytes, entries: zip.entries, sha256: await hashFile(portableZip) };
  if (!args.includes('--no-installer')) {
    const stub = path.join(windowsRoot, 'dist/installer/grokbot-setup-stub.exe');
    const stubBytes = (await stat(stub)).size;
    created.push(setupExe);
    const target = createWriteStream(setupExe, { flags: 'wx' });
    await pipeline(createReadStream(stub), target, { end: false });
    await pipeline(createReadStream(portableZip), target, { end: false });
    const footer = Buffer.alloc(32);
    footer.writeBigUInt64LE(BigInt(stubBytes), 0); footer.writeBigUInt64LE(BigInt(zip.bytes), 8);
    footer.write('GROKBOT-SETUP-V1', 16, 'latin1');
    target.end(footer);
    await new Promise((resolve, reject) => target.once('close', resolve).once('error', reject));
    manifest.installer = { path: setupExe, bytes: (await stat(setupExe)).size, sha256: await hashFile(setupExe) };
  }
  manifest.timings.totalSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(3));
  await writeFile(path.join(outputRoot, `GrokBotLocal-${supported.version}-x64.patch.json`), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  for (const target of created.reverse()) await rm(target, { recursive: true, force: true });
  console.error(error.message); process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
