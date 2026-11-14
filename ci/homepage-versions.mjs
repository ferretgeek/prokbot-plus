// Render only the marked portions of each README. An official feed does not change any build pin.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const json = async file => JSON.parse(await readFile(new URL(file, root), 'utf8'));
const version = /^\d+\.\d+\.\d+$/;
const official = {
  win: 'https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand',
  mac: 'https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand',
  ios: 'https://apps.apple.com/us/app/grok-bot/id6794501026',
};

export async function readVersions() {
  const [snap, win, mac, ios, android, host] = await Promise.all(['ci/official-snapshot.json',
    'windows/patchers/desktop/supported.json', 'mac/patchers/desktop/supported.json', 'ios/recipes/ios/manifest.json',
    'android/patchers/supported.json', 'host/recipes/host/manifest.json'].map(json));
  assert.match(snap.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snap.ios.trackId, 6794501026); assert.equal(snap.ios.store, 'us');
  for (const channel of [snap.windows, snap.mac]) assert.match(channel.build, /^[a-f0-9]{40}$/);
  for (const v of [snap.windows.version, snap.mac.version, snap.ios.version, win.version, mac.version, ios.version,
    android.desktopVersion, android.shell.versionName]) assert.match(v, version);
  assert.ok(Number.isSafeInteger(android.shell.versionCode) && android.shell.versionCode > 0);
  assert.equal(android.desktopVersion, win.version); assert.match(ios.build, /^\d+$/);
  assert.match(host.archive.version, /^[a-f0-9]{7,40}$/);
  const box = /^grokbot-box-input:([a-f0-9]{7,40})$/.exec(host.box.localTag);
  assert.ok(box); assert.equal(host.box.platform, 'linux/amd64');
  return { snap, win, mac, ios, android, host: host.archive.version, box: box[1] };
}

function block(text, name, body) {
  const a = `<!-- ${name}:start -->`, b = `<!-- ${name}:end -->`;
  assert.equal(text.split(a).length, 2, `${name}: missing or duplicate start`);
  assert.equal(text.split(b).length, 2, `${name}: missing or duplicate end`);
  const start = text.indexOf(a) + a.length, end = text.indexOf(b);
  assert.ok(start < end, `${name}: reversed markers`);
  return text.slice(0, start) + '\n' + body + '\n' + text.slice(end);
}

export function render(text, lang, data) {
  assert.ok(['zh','en'].includes(lang));
  const { snap, win, mac, ios, android, host, box } = data;
  const zh = lang === 'zh', label = zh ? '官方' : 'official';
  function badge(name, value, description, logo, color) {
    return `  <a href="#client-versions"><img alt="${description}" src="https://img.shields.io/badge/${encodeURIComponent(name)}-${encodeURIComponent(value)}-${color}?logo=${logo}&logoColor=white"></a>`;
  }
  const badges = [badge(`Windows ${label}`,`${snap.windows.version} x64`,`Windows ${label} ${snap.windows.version} x64`,'windows','0078D4'),
    badge(`macOS ${label}`,`${snap.mac.version} ARM64`,`macOS ${label} ${snap.mac.version} ARM64`,'apple','111111'),
    badge(`iOS ${label}`,snap.ios.version,`iOS ${label} ${snap.ios.version}`,'apple','111111'),
    badge(zh ? '自开发 Android' : 'Unofficial Android',android.shell.versionName,`Android shell ${android.shell.versionName}`,'android','237E55')].join('\n');
  const table = [zh ? `**安装时选哪一版？** 官方稳定通道核对日期：${snap.checkedOn}。请使用右栏的原包；左栏是厂商版本，不代表 Plus 已兼容。` :
    `**Which version should I install?** Official channels checked on ${snap.checkedOn}. Use the input in the right column. A newer vendor release is not a Plus compatibility claim.`, '',
    zh ? '| 平台 | 官方最新 | 本项目接受的原包 / 外壳 |' : '| Platform | Latest official release | Input accepted by Plus / shell version |',
    '| --- | --- | --- |',
    `| Windows x64 | [${snap.windows.version}](${official.win}) | ${win.version} |`,
    `| macOS ARM64 | [${snap.mac.version}](${official.mac}) | ${mac.version}${zh ? '；无 Mac 真机测试' : '; no Mac hardware test'} |`,
    `| iOS | [${snap.ios.version}](${official.ios}) | ${ios.version} (${ios.build})${zh ? '；无 iPhone / iPad 真机测试' : '; no iPhone or iPad hardware test'} |`,
    zh ? `| Android 9+（自开发，非官方） | 不使用官方 Android APK | 外壳 **${android.shell.versionName}**（构建 ${android.shell.versionCode}），界面来自 Windows **${android.desktopVersion}** |` :
      `| Android 9+ (unofficial) | Does not use the official Android APK | Shell **${android.shell.versionName}** (build ${android.shell.versionCode}), renderer from Windows **${android.desktopVersion}** |`,
    zh ? `| Linux Host / 执行桌面 | 无可核对的最新镜像映射 | Host \`${host}\`；执行桌面 \`${box}\`（amd64） |` :
      `| Linux Host / execution desktop | No published mapping to the latest desktop release | Host \`${host}\`; execution desktop \`${box}\` (amd64) |`, '',
    zh ? '[ProkBot Plus 的最新发布包](https://github.com/ferretgeek/prokbot-plus/releases/latest)使用项目自己的版本号；上游 ProkBot 基线是 `3e9fe8c`。' :
      '[Latest ProkBot Plus release](https://github.com/ferretgeek/prokbot-plus/releases/latest) uses the project’s own version number. The upstream ProkBot baseline is `3e9fe8c`.'].join('\n');
  return block(block(text,'client-badges',badges),'client-versions',table);
}

async function main(argv) {
  if (argv.length > 1 || (argv.length && argv[0] !== '--write')) throw Error('Usage: node ci/homepage-versions.mjs [--write]');
  const data = await readVersions();
  for (const [file,lang] of [['README.md','zh'],['README.en.md','en']]) {
    const url = new URL(file,root), original = await readFile(url,'utf8'), expected = render(original,lang,data);
    if (expected === original) continue;
    if (argv[0] !== '--write') throw Error(`${file}: generated version information is stale`);
    await writeFile(url,expected);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode=1; });
}
