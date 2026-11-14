import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

async function knownUnsupportedVersion(source) {
  const { version, archiveBytes, observedArchiveSha256 } = JSON.parse(
    await readFile(new URL('./known-unsupported.json', import.meta.url), 'utf8'));
  const candidate = await stat(source);
  if (!candidate.isFile() || candidate.size !== archiveBytes) return;

  const file = await open(source, 'r');
  try {
    // Check and hash the same handle; an appended tail must not pass as an exact installer.
    const before = await file.stat();
    if (!before.isFile() || before.size !== archiveBytes) return;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({ start: 0, end: archiveBytes - 1, autoClose: false })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== archiveBytes || hash.digest('hex') !== observedArchiveSha256) return;
    const after = await file.stat();
    if (after.size === archiveBytes && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs) return version;
  } finally { await file.close(); }
}

export async function withInstallerDiagnostic(verification, explicitSource, supported) {
  try { return await verification; }
  catch (cause) {
    // The shared Windows/Android wrapper verifier reports this exact, untyped pin error.
    if (cause?.message !== '官方安装包摘要不匹配。' || !explicitSource || path.extname(explicitSource).toLowerCase() !== '.exe') throw cause;
    const version = await knownUnsupportedVersion(explicitSource).catch(() => undefined);
    const target = `Grok Bot ${supported.version} Windows ${supported.architecture}`;
    const [zh, en] = version ? [
      `这是官方 Grok Bot ${version} 安装包，与当前 ProkBot Plus 补丁不兼容。`,
      `The official Grok Bot ${version} installer is incompatible with this ProkBot Plus patch.`,
    ] : [
      '安装包摘要不匹配，无法确认此文件的版本或来源。',
      'Installer fingerprint mismatch. The version and origin of this file are unverified.',
    ];
    throw new Error(`${zh}未进入配对。\n省略 --source 重新运行即可下载并校验补丁支持的 ${target} 安装包，无需卸载现有客户端。\n` +
      `${en} Pairing did not run.\nOmit --source to fetch the exact supported ${target} installer. No need to uninstall your existing app.`, { cause });
  }
}
