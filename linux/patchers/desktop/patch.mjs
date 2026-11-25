#!/usr/bin/env node
// Build the Linux x64 / arm64 client from the official Grok Bot .deb package:
// verify the pinned original, replace the main process with the shared local client,
// apply the Linux recipes, repack app.asar, bundle Linux Tailcat and portable
// launcher/installer scripts, and produce a portable folder, .tar.gz and manifest.
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { applyReleaseRecipes } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { extractNotificationPolicy } from '../../../mac/patchers/desktop/extract-policy.mjs';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { hashFile, unpackOriginal } from './deb.mjs';
import { APP_ID, installScript, launcherScript, setupAppArmorScript, uninstallScript } from './launcher.mjs';
import { checkOutputLocation, publishBuild } from './output.mjs';
import { writeTarGz } from './tar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const linuxRoot = path.resolve(here, '../..');
const repo = path.resolve(linuxRoot, '..');
const inputDirectories = { x64: here, arm64: path.join(here, 'arm64') };
const tailcatBinaries = {
  x64: path.join(repo, 'host/bin/grokbot-tailcat'),
  arm64: path.join(repo, 'host/bin/linux-arm64/grokbot-tailcat'),
};
const EXE = 'grok-bot';
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (args.includes('--help')) {
  console.log(`node linux/patchers/desktop/patch.mjs [--arch <x64|arm64>] [--source <grok-bot_1.3.0_<amd64|arm64>.deb | 安装目录>]
    [--output <目录>] [--no-archive] [--verify-only]
省略 --source 时自动下载并校验 1.3.0 Linux 原版 .deb；省略 --arch 时按原版 .deb 大小或本机架构选择（x64 / arm64）。
默认输出到 linux/output/，包含便携目录（grokbot-local/）、便携压缩包（.tar.gz）及用户级安装脚本（install.sh）。`);
  process.exit(0);
}
// --verify-only writes nothing, so it also runs on Windows; building needs POSIX file modes.
if (process.platform === 'win32' && !args.includes('--verify-only')) throw new Error('Linux 客户端需要在 Linux 或 macOS 上生成（需要保留 POSIX 文件权限）。');

const startedAt = performance.now();
const outputRoot = path.resolve(arg('--output') ?? path.join(linuxRoot, 'output'));
const appOutput = path.join(outputRoot, APP_ID);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function unpackedFiles(header, prefix = '') {
  const result = [];
  for (const [name, entry] of Object.entries(header.files ?? {})) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (entry.files) result.push(...unpackedFiles(entry, relative));
    else if (entry.unpacked) result.push(relative);
  }
  return result;
}

async function detectSourceArch(source) {
  if (!source || path.extname(source).toLowerCase() !== '.deb') return null;
  const { size } = await stat(path.resolve(source));
  for (const [name, directory] of Object.entries(inputDirectories)) {
    const supported = JSON.parse(await readFile(path.join(directory, 'supported.json'), 'utf8'));
    if (supported.archive.bytes === size) return name;
  }
  return null;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'grokbot-linux-patch-'));
let stage, createdRoot;
async function build() {
  const explicitSource = arg('--source');
  const arch = arg('--arch') ?? await detectSourceArch(explicitSource) ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  if (!Object.hasOwn(inputDirectories, arch)) throw new Error('--arch 只能是 x64 或 arm64。');
  const directory = inputDirectories[arch];
  const supported = JSON.parse(await readFile(path.join(directory, 'supported.json'), 'utf8'));
  const portableArchive = path.join(outputRoot, `GrokBotLocal-${supported.version}-${arch}-linux.tar.gz`);
  const manifestPath = path.join(outputRoot, `GrokBotLocal-${supported.version}-${arch}.patch.json`);

  const source = await acquireDesktopSource({
    source: explicitSource,
    cacheDirectory: path.join(linuxRoot, '.cache'),
    supported,
    onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Linux ${arch}…`),
  });
  const app = await unpackOriginal(source, temporary, supported);
  const originalExe = path.join(app, EXE);
  const originalAsar = path.join(app, 'resources/app.asar');
  const [exeSha256, asarSha256] = await Promise.all([hashFile(originalExe), hashFile(originalAsar)]);
  if (exeSha256 !== supported.exeSha256 || asarSha256 !== supported.asarSha256) {
    throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} Linux ${supported.architecture}；程序或 ASAR 摘要不匹配。另一种架构请加 --arch ${arch === 'arm64' ? 'x64' : 'arm64'}。`);
  }

  let asar;
  try { asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar'); }
  catch { throw new Error('缺少 @electron/asar；执行 npm install --prefix mac/patchers/desktop。'); }

  const unpacked = path.join(temporary, 'app');
  asar.extractAll(originalAsar, unpacked);
  const originalUnpacked = new Set(unpackedFiles(asar.getRawHeader(originalAsar).header));
  const notificationPolicy = await extractNotificationPolicy(unpacked, directory);
  const pkgPath = path.join(unpacked, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.version !== supported.version) throw new Error('ASAR 包版本不一致。');
  if (sha(asar.getRawHeader(originalAsar).headerString) !== supported.asarHeaderSha256) throw new Error('ASAR header fingerprint mismatch');

  const patchStarted = performance.now();
  await applyReleaseRecipes(unpacked, path.join(directory, 'recipes'));
  const patchSeconds = Number(((performance.now() - patchStarted) / 1000).toFixed(3));
  console.log(JSON.stringify({ verified: true, recipesVerified: true, version: supported.version, architecture: supported.architecture, asarSha256 }));
  if (args.includes('--verify-only')) return;

  const noArchive = args.includes('--no-archive');
  const targets = [appOutput, manifestPath, ...(noArchive ? [] : [portableArchive])];
  await checkOutputLocation(source, outputRoot, targets);
  createdRoot = await mkdir(outputRoot, { recursive: true });
  stage = await mkdtemp(path.join(outputRoot, '.grokbot-build-'));
  const stagedApp = path.join(stage, APP_ID);
  await cp(app, stagedApp, {
    recursive: true,
    filter: async name => {
      if ((await lstat(name)).isSymbolicLink()) throw new Error(`Source contains a link: ${name}`);
      return true;
    },
  });

  const previousMain = pkg.main;
  pkg.main = 'local-client/main.mjs';
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  const clients = path.join(repo, 'mac/clients');
  await cp(path.join(clients, 'desktop'), path.join(unpacked, 'local-client'), {
    recursive: true,
    filter: filename => path.basename(filename) !== 'notification-policy.mjs',
  });
  await writeFile(path.join(unpacked, 'local-client/notification-policy.mjs'), notificationPolicy);
  await cp(path.join(clients, 'shared'), path.join(unpacked, 'shared'), { recursive: true });
  await cp(path.join(stagedApp, 'resources/icon.png'), path.join(unpacked, 'local-client/icon.png'));

  const outAsar = path.join(stagedApp, 'resources/app.asar');
  await rm(outAsar);
  await rm(`${outAsar}.unpacked`, { recursive: true, force: true });
  await asar.createPackageWithOptions(unpacked, outAsar, {
    unpack: '{**/*.node,**/dist/native/**,**/dist/deps/**,**/onepassword-connection-service.cjs}',
  });
  const patchedUnpacked = new Set(unpackedFiles(asar.getRawHeader(outAsar).header));
  const missing = [...originalUnpacked].filter(name => !patchedUnpacked.has(name));
  const extra = [...patchedUnpacked].filter(name => !originalUnpacked.has(name));
  if (missing.length || extra.length) throw new Error(`解包文件与原版不一致：${[...missing, ...extra].slice(0, 5).join(', ')}`);
  const headerSha256 = sha(asar.getRawHeader(outAsar).headerString);

  // Remove the upstream /opt/Grok Bot AppArmor profile; setup-apparmor.sh writes one for the installed path.
  await rm(path.join(stagedApp, 'resources/apparmor-profile'), { force: true });

  await cp(tailcatBinaries[arch], path.join(stagedApp, 'resources/grokbot-tailcat'));
  await chmod(path.join(stagedApp, 'resources/grokbot-tailcat'), 0o755);
  await cp(path.join(repo, 'mac/network/TAILCAT-LICENSE'), path.join(stagedApp, 'resources/TAILCAT-LICENSE'));

  for (const bin of [EXE, 'chrome-sandbox', 'chrome_crashpad_handler']) {
    const file = path.join(stagedApp, bin);
    try { await chmod(file, 0o755); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  for (const [name, content] of [
    [APP_ID, launcherScript()],
    ['install.sh', installScript()],
    ['uninstall.sh', uninstallScript()],
    ['setup-apparmor.sh', setupAppArmorScript()],
  ]) {
    const target = path.join(stagedApp, name);
    await writeFile(target, content, { mode: 0o755 });
    await chmod(target, 0o755);
  }

  if (await hashFile(originalAsar) !== asarSha256) throw new Error('原版文件意外变化。');

  const manifest = {
    patchedAt: new Date().toISOString(),
    version: supported.version,
    architecture: supported.architecture,
    originalAsarSha256: asarSha256,
    patchedAsarSha256: await hashFile(outAsar),
    asarHeaderSha256: headerSha256,
    originalEntry: previousMain,
    patchedEntry: pkg.main,
    desktopId: `${APP_ID}.desktop`,
    executable: { originalSha256: exeSha256, patchedSha256: exeSha256, modified: false },
    profile: '~/.config/Grok Bot Local',
    automaticUpdates: false,
    computerUse: 'unavailable on Linux',
    unpackedFiles: patchedUnpacked.size,
    timings: { patchSeconds },
  };
  await writeFile(path.join(stagedApp, 'resources/grokbot-local.patch.json'), JSON.stringify(manifest, null, 2));
  Object.assign(manifest, { source, output: appOutput });

  const staged = name => path.join(stage, path.basename(name));
  const files = [];
  if (!noArchive) {
    const archive = await writeTarGz(stagedApp, staged(portableArchive));
    manifest.portableArchive = { path: portableArchive, bytes: archive.bytes, sha256: await hashFile(staged(portableArchive)) };
    files.push({ source: staged(portableArchive), destination: portableArchive, sha256: manifest.portableArchive.sha256 });
  }
  manifest.timings.totalSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(3));
  const report = JSON.stringify(manifest, null, 2);
  await writeFile(staged(manifestPath), report, { flag: 'wx' });
  files.push({ source: staged(manifestPath), destination: manifestPath, sha256: sha(report) });
  await checkOutputLocation(source, outputRoot, targets);
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
