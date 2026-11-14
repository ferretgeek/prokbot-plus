#!/usr/bin/env node
// Build the Windows x64 client from the official Grok Bot installer: verify the
// pinned original, replace the main process with the local client, apply the
// Windows recipes, repack, record the new ASAR integrity in the executable and
// produce a portable folder, a portable zip and a per-user installer.
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, lstat, cp, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyReleaseRecipes } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { extractNotificationPolicy } from '../../../mac/patchers/desktop/extract-policy.mjs';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { applicationIcon, replaceAsarIntegrity, stripAuthenticode } from './pe.mjs';
import { unpackOriginal } from './original.mjs';
export { carveSevenZip } from './original.mjs';
import { writeZip } from './zip.mjs';
import { checkOutputLocation, publishBuild, writeSetup } from './output.mjs';

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
const manifestPath = path.join(outputRoot, `GrokBotLocal-${supported.version}-x64.patch.json`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
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
let stage, createdRoot;
async function build() {
  const source = await acquireDesktopSource({ source: arg('--source'), cacheDirectory: path.join(windowsRoot, '.cache'), supported,
    onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Windows x64…`) });
  const app = await unpackOriginal(source, temporary, supported);
  const originalExe = path.join(app, EXE), originalAsar = path.join(app, 'resources/app.asar');
  const [exeSha256, asarSha256] = await Promise.all([hashFile(originalExe), hashFile(originalAsar)]);
  if (exeSha256 !== supported.exeSha256 || asarSha256 !== supported.asarSha256)
    throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} Windows ${supported.architecture}；程序或 ASAR 摘要不匹配。`);
  const targets = [appOutput, portableZip, manifestPath, ...(args.includes('--no-installer') ? [] : [setupExe])];
  let asar;
  try { asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar'); }
  catch { throw new Error('缺少 @electron/asar；执行 npm install --prefix mac/patchers/desktop。'); }

  const unpacked = path.join(temporary, 'app');
  asar.extractAll(originalAsar, unpacked);
  const originalUnpacked = new Set(unpackedFiles(asar.getRawHeader(originalAsar).header));
  const notificationPolicy = await extractNotificationPolicy(unpacked, here);
  const pkgPath = path.join(unpacked, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.version !== supported.version) throw new Error('ASAR 包版本不一致。');
  if (sha(asar.getRawHeader(originalAsar).headerString) !== supported.asarHeaderSha256) throw new Error('ASAR header fingerprint mismatch');
  const patchStarted = performance.now();
  await applyReleaseRecipes(unpacked, path.join(here, 'recipes'));
  const patchSeconds = Number(((performance.now() - patchStarted) / 1000).toFixed(3));
  console.log(JSON.stringify({ verified: true, recipesVerified: true, version: supported.version, architecture: supported.architecture, asarSha256 }));
  if (args.includes('--verify-only')) return;
  await checkOutputLocation(source, outputRoot, targets);
  createdRoot = await mkdir(outputRoot, { recursive: true });
  stage = await mkdtemp(path.join(outputRoot, '.grokbot-build-'));
  const stagedApp = path.join(stage, APP);
  await cp(app, stagedApp, { recursive: true, filter: async name => {
    if ((await lstat(name)).isSymbolicLink()) throw new Error(`Source contains a link: ${name}`);
    return true;
  } });
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

  const outAsar = path.join(stagedApp, 'resources/app.asar');
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
  const exePath = path.join(stagedApp, EXE);
  const exe = stripAuthenticode(replaceAsarIntegrity(await readFile(exePath), supported.asarHeaderSha256, headerSha256));
  await writeFile(exePath, exe);
  await cp(path.join(windowsRoot, 'dist/network/grokbot-tailcat.exe'), path.join(stagedApp, 'resources/grokbot-tailcat.exe'));
  await cp(path.join(repo, 'mac/network/TAILCAT-LICENSE'), path.join(stagedApp, 'resources/TAILCAT-LICENSE'));
  if (await hashFile(originalAsar) !== asarSha256) throw new Error('原版文件意外变化。');

  const manifest = { patchedAt: new Date().toISOString(), version: supported.version,
    architecture: supported.architecture, originalAsarSha256: asarSha256, patchedAsarSha256: await hashFile(outAsar),
    asarHeaderSha256: headerSha256, originalEntry: previousMain, patchedEntry: pkg.main, appUserModelId: 'dev.grokbot.local',
    executable: { originalSha256: exeSha256, patchedSha256: sha(exe), signature: 'removed' },
    profile: '%APPDATA%\\Grok Bot Local', automaticUpdates: false, computerUse: 'unavailable on Windows',
    unpackedFiles: patchedUnpacked.size, timings: { patchSeconds } };
  await writeFile(path.join(stagedApp, 'resources/grokbot-local.patch.json'), JSON.stringify(manifest, null, 2));
  Object.assign(manifest, { source, output: appOutput }); // Machine paths belong only in the local build report.

  const staged = name => path.join(stage, path.basename(name));
  const zip = await writeZip(stagedApp, staged(portableZip), { prefix: APP, comment: supported.version });
  manifest.portableZip = { path: portableZip, bytes: zip.bytes, entries: zip.entries, sha256: await hashFile(staged(portableZip)) };
  if (!args.includes('--no-installer')) {
    const stub = path.join(windowsRoot, 'dist/installer/grokbot-setup-stub.exe');
    await writeSetup(stub, staged(portableZip), staged(setupExe), zip.bytes);
    manifest.installer = { path: setupExe, bytes: (await stat(staged(setupExe))).size, sha256: await hashFile(staged(setupExe)) };
  }
  manifest.timings.totalSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(3));
  const report = JSON.stringify(manifest, null, 2);
  await writeFile(staged(manifestPath), report, { flag: 'wx' });
  await checkOutputLocation(source, outputRoot, targets);
  const files = [
    { source: staged(portableZip), destination: portableZip, sha256: manifest.portableZip.sha256 },
    { source: staged(manifestPath), destination: manifestPath, sha256: sha(report) },
  ];
  if (manifest.installer) files.push({ source: staged(setupExe), destination: setupExe, sha256: manifest.installer.sha256 });
  await publishBuild(stagedApp, appOutput, files);
  console.log(report);
}
try {
  await build();
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  try {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (createdRoot && process.exitCode === 1) {
      for (let dir = outputRoot; ; dir = path.dirname(dir)) {
        try { await rmdir(dir); } catch (error) { if (error.code === 'ENOTEMPTY') break; throw error; }
        if (dir === createdRoot) break;
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
