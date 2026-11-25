// Render only the marked portions of each README. An official feed does not change any build pin.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsReleases } from '../windows/patchers/desktop/inputs.mjs';

const root = new URL('../', import.meta.url);
const json = async file => JSON.parse(await readFile(new URL(file, root), 'utf8'));
const version = /^\d+\.\d+\.\d+$/;
const official = {
  win: 'https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand',
  mac: 'https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand',
  macIntel: 'https://api2.cursor.sh/updates/api/download/stable/darwin-x64/sand',
  linux: 'https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand',
  linuxArm64: 'https://api2.cursor.sh/updates/api/download/stable/linux-arm64/sand',
  ios: 'https://apps.apple.com/us/app/grok-bot/id6794501026',
};
// Releases last confirmed on real machines; a newer pin says it is untested until then.
const tested = { linux: '1.3.0', macIntel: '1.2.3', ios: '1.27.0' };

export async function readVersions() {
  const [snap, mac, macIntel, linux, linuxArm64, ios, android, host] = await Promise.all(['ci/official-snapshot.json',
    'mac/patchers/desktop/supported.json', 'mac/patchers/desktop/x64/supported.json',
    'linux/patchers/desktop/supported.json', 'linux/patchers/desktop/arm64/supported.json',
    'ios/recipes/ios/manifest.json',
    'android/patchers/supported.json', 'host/recipes/host/manifest.json'].map(json));
  // The recommended Windows release first, then the older ones the patch still builds.
  const [win, ...winFallback] = (await windowsReleases()).map(release => release.supported);
  const androidFallback = (android.fallback ?? []).map(item => item.desktopVersion);
  assert.match(snap.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snap.ios.trackId, 6794501026); assert.equal(snap.ios.store, 'us');
  for (const channel of [snap.windows, snap.mac, snap.linux]) assert.match(channel.build, /^[a-f0-9]{40}$/);
  for (const v of [snap.windows.version, snap.mac.version, snap.linux.version, snap.ios.version, win.version, ...winFallback.map(item => item.version),
    mac.version, macIntel.version, linux.version, linuxArm64.version, ios.version, android.desktopVersion, ...androidFallback, android.shell.versionName]) assert.match(v, version);
  assert.ok(Number.isSafeInteger(android.shell.versionCode) && android.shell.versionCode > 0);
  assert.match(ios.build, /^\d+$/);
  assert.match(host.archive.version, /^[a-f0-9]{7,40}$/);
  const box = /^grokbot-box-input:([a-f0-9]{7,40})$/.exec(host.box.localTag);
  assert.ok(box); assert.equal(host.box.platform, 'linux/amd64');
  return { snap, win, winFallback, mac, macIntel, linux, linuxArm64, ios, android, androidFallback, host: host.archive.version, box: box[1] };
}

function block(text, name, body) {
  const a = `<!-- ${name}:start -->`, b = `<!-- ${name}:end -->`;
  assert.equal(text.split(a).length, 2, `${name}: missing or duplicate start`);
  assert.equal(text.split(b).length, 2, `${name}: missing or duplicate end`);
  const start = text.indexOf(a) + a.length, end = text.indexOf(b);
  assert.ok(start < end, `${name}: reversed markers`);
  return text.slice(0, start) + '\n' + body + '\n' + text.slice(end);
}

// The official installer counts as supported only with the exact version and bytes of a pinned release.
function windowsNote(observed, accepted, zh) {
  if (accepted.some(pin => observed.version === pin.version && observed.observedArchiveSha256 === pin.archive?.sha256)) return '';
  return zh ? '此补丁不支持' : 'not supported by this patch';
}

function iosNote(observed, pinned, zh) {
  if (observed.version === pinned.version) return '';
  return zh ? '此补丁不支持' : 'not supported by this patch';
}

export function render(text, lang, data) {
  assert.ok(['zh','en'].includes(lang));
  const { snap, win, winFallback, mac, macIntel, linux, linuxArm64, ios, android, androidFallback, host, box } = data;
  const zh = lang === 'zh', label = zh ? '官方' : 'official';
  const list = items => items.join(zh ? '、' : ', ');
  function badge(name, value, description, logo, color) {
    return `  <a href="#client-versions"><img alt="${description}" src="https://img.shields.io/badge/${encodeURIComponent(name)}-${encodeURIComponent(value)}-${color}?logo=${logo}&logoColor=white"></a>`;
  }
  const windowsBadge = (name, value, color) => badge(name,value,`${name} ${value}`,'windows',color);
  const note = windowsNote(snap.windows, [win, ...winFallback], zh);
  const linuxNote = windowsNote(snap.linux, [linux], zh);
  const iosUnsupported = iosNote(snap.ios, ios, zh);
  const older = winFallback.map(item => item.version);
  const accepted = older.length ? `${win.version} x64${zh ? `（推荐）、${list(older)}` : ` (recommended), ${list(older)}`}` : `${win.version} x64`;
  const windowsNeeds = older.length ? (zh ? `**${win.version}**（推荐）；用不了再用 ${list(older)}` :
    `**${win.version}** (recommended); ${list(older)} if it does not work`) : win.version;
  const androidNeeds = androidFallback.length ? (zh ? `（推荐；用不了再用 ${list(androidFallback)}）` :
    ` (recommended; ${list(androidFallback)} if it does not work)`) : '';
  const macNote = snap.mac.version === mac.version ? '' : zh ? `尚未适配 ${snap.mac.version}；` : `not yet adapted to ${snap.mac.version}; `;
  const linuxVersionNote = snap.linux.version === linux.version ? '' : zh ? `尚未适配 ${snap.linux.version}；` : `not yet adapted to ${snap.linux.version}; `;
  const linuxTested = linux.version === tested.linux
    ? (zh ? '已在 Ubuntu 24.04 x64 的容器（虚拟显示）里实测，原生桌面和 ARM64 未实测' : 'tested on Ubuntu 24.04 x64 in a container with a virtual display; native desktops and ARM64 untested')
    : (zh ? `${linux.version} 尚未实测；${tested.linux} 曾在 Ubuntu 24.04 x64 的容器（虚拟显示）里实测，原生桌面和 ARM64 未实测`
      : `${linux.version} not yet tested; ${tested.linux} was tested on Ubuntu 24.04 x64 in a container with a virtual display; native desktops and ARM64 untested`);
  const macIntelTested = macIntel.version === tested.macIntel
    ? (zh ? `已在 Intel Mac 上实测 ${tested.macIntel} 可用` : `tested working on an Intel Mac with ${tested.macIntel}`)
    : (zh ? `${macIntel.version} 未在 Mac 真机上测试；${tested.macIntel} 曾在 Intel Mac 上实测可用`
      : `${macIntel.version} not tested on a Mac; ${tested.macIntel} was tested working on an Intel Mac`);
  const iosTested = ios.version === tested.ios
    ? (zh ? '已在 iPad 上验证连接、发消息和 App Intent' : 'pairing, messaging and App Intents verified on an iPad')
    : (zh ? `${ios.version} 尚未完成全部真机回归（仅在 iPhone 上实测部分项目）；${tested.ios} 曾在 iPad 上验证连接、发消息和 App Intent`
      : `${ios.version} not yet fully live-tested (partial iPhone testing only); ${tested.ios} was verified on an iPad for pairing, messaging and App Intents`);
  const badges = [windowsBadge(`Windows ${label}`,`${snap.windows.version} x64${note ? ` (${note})` : ''}`,'0078D4'),
    windowsBadge(zh ? 'Windows 补丁接受' : 'Windows patch accepts',accepted,'237E55'),
    badge(`Linux ${label}`,`${snap.linux.version} x64 / ARM64${linuxNote ? ` (${linuxNote})` : ''}`,`Linux ${label} ${snap.linux.version} x64 / ARM64${linuxNote ? ` (${linuxNote})` : ''}`,'linux','237E55'),
    badge(`macOS ${label}`,`${snap.mac.version} ARM64 / Intel`,`macOS ${label} ${snap.mac.version} ARM64 / Intel`,'apple','111111'),
    badge(`iOS ${label}`,snap.ios.version,`iOS ${label} ${snap.ios.version}`,'apple','111111'),
    badge(zh ? '自开发 Android' : 'Unofficial Android',android.shell.versionName,`Android shell ${android.shell.versionName}`,'android','237E55'),
    // The web client builds the Android interface for browsers (web/patchers/patch.mjs).
    badge(zh ? '网页版' : 'Web client',android.desktopVersion,`${zh ? '网页版' : 'Web client'} ${android.desktopVersion}`,'googlechrome','237E55')].join('\n');
  const table = [zh ? `**下载哪个版本的官方安装包？** 按右栏下载，补丁只认这些版本。列了两个版本时先用推荐的新版，用不了再换旧版。左栏是官方当前最新版（${snap.checkedOn} 核对），比右栏新时要等本项目适配。` :
    `**Which official version should I download?** The one in the right column; the patches accept only those versions. Where two versions are listed, use the recommended newer one first and switch to the older one only if it does not work. The left column is the latest official release (checked ${snap.checkedOn}); when it is newer, wait until this project supports it.`, '',
    zh ? '| 平台 | 官方最新版 | 本项目需要的版本 |' : '| Platform | Latest official | Version this project needs |',
    '| --- | --- | --- |',
    `| Windows x64 | [${snap.windows.version}](${official.win})${note ? (zh ? `（${note}）` : ` (${note})`) : ''} | ${windowsNeeds} |`,
    `| Linux x64 / ARM64 | [${snap.linux.version}](${official.linux})${linuxNote ? (zh ? `（${linuxNote}）` : ` (${linuxNote})`) : ''} | ${linux.version}${linuxArm64.version === linux.version ? '' : ` / ${linuxArm64.version}`}${zh ? `（${linuxVersionNote}.deb 原包；${linuxTested}）` : ` (${linuxVersionNote}.deb archive; ${linuxTested})`} |`,
    `| macOS ARM64 | [${snap.mac.version}](${official.mac}) | ${mac.version}${zh ? `（${macNote}未在 Mac 真机上测试）` : ` (${macNote}not tested on a Mac)`} |`,
    `| macOS Intel (x64) | [${snap.mac.version}](${official.macIntel}) | ${macIntel.version}${zh ? `（${macNote}${macIntelTested}）` : ` (${macNote}${macIntelTested})`} |`,
    `| iOS | [${snap.ios.version}](${official.ios})${iosUnsupported ? (zh ? `（${iosUnsupported}）` : ` (${iosUnsupported})`) : ''} | ${ios.version}${zh ? `（构建 ${ios.build}；${iosTested}）` : ` (build ${ios.build}; ${iosTested})`} |`,
    zh ? `| Android 9+（自开发，非官方） | 不用官方 Android 版 | App **${android.shell.versionName}**（构建 ${android.shell.versionCode}），界面取自 Windows **${android.desktopVersion}** 安装包${androidNeeds} |` :
      `| Android 9+ (unofficial) | Does not use the official Android app | App **${android.shell.versionName}** (build ${android.shell.versionCode}), interface taken from the Windows **${android.desktopVersion}** installer${androidNeeds} |`,
    zh ? `| 网页版（浏览器，非官方） | 不用安装 | 界面取自 Windows **${android.desktopVersion}** 安装包${androidNeeds}，生成后上传到你的 Host |` :
      `| Web client (browser, unofficial) | Nothing to install | Interface taken from the Windows **${android.desktopVersion}** installer${androidNeeds}, built once and uploaded to your Host |`,
    zh ? `| Linux 服务端 | 不适用 | Host \`${host}\`；Bot 的电脑 \`${box}\`（x86_64） |` :
      `| Linux server | n/a | Host \`${host}\`; Bot computer \`${box}\` (x86_64) |`, '',
    zh ? 'ProkBot Plus 自己的版本号见[最新发布](https://github.com/ferretgeek/prokbot-plus/releases/latest)；上游 ProkBot 基线是 `3e9fe8c`。' :
      'ProkBot Plus has its own version numbers; see the [latest release](https://github.com/ferretgeek/prokbot-plus/releases/latest). The upstream ProkBot baseline is `3e9fe8c`.'].join('\n');
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
