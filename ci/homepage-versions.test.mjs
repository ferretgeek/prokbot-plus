import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readVersions, render } from './homepage-versions.mjs';

const middle = '<!-- client-badges:end -->\r\n<p>unrelated edit</p>\r\n<!-- client-versions:start -->';
const fixture = `<p>before</p>\n<!-- client-badges:start -->\n${middle}\n<!-- client-versions:end -->\n<p>after</p>\n`;
const copy = {
  zh: { official: 'Windows 官方', input: 'Windows 补丁接受', unsupported: '此补丁不支持',
    accepted: (pin, older) => older.length ? `${pin} x64（推荐）、${older.join('、')}` : `${pin} x64`,
    needs: (pin, older) => older.length ? `**${pin}**（推荐）；用不了再用 ${older.join('、')}` : pin },
  en: { official: 'Windows official', input: 'Windows patch accepts', unsupported: 'not supported by this patch',
    accepted: (pin, older) => older.length ? `${pin} x64 (recommended), ${older.join(', ')}` : `${pin} x64`,
    needs: (pin, older) => older.length ? `**${pin}** (recommended); ${older.join(', ')} if it does not work` : pin },
};

// Keep the cases independent of the rolling snapshot and build pins.
async function fixtureData() {
  const data = await readVersions();
  data.win = { ...data.win, version: '1.1.0', archive: { ...data.win.archive, sha256: 'a'.repeat(64) } };
  data.winFallback = [{ ...data.win, version: '0.71.2', archive: { ...data.win.archive, sha256: 'b'.repeat(64) } }];
  data.snap = { ...data.snap, windows: { ...data.snap.windows, version: '1.1.0', observedArchiveSha256: 'a'.repeat(64) } };
  return data;
}

function assertWindows(page, lang, observed, data, note = '') {
  const lines = page.split('<!-- client-badges:start -->')[1].split('<!-- client-badges:end -->')[0].trim().split('\n');
  const { official, input, accepted, needs } = copy[lang], older = data.winFallback.map(item => item.version);
  const expected = [[official, `${observed} x64${note ? ` (${note})` : ''}`], [input, accepted(data.win.version, older)]];
  for (const [i, [label, value]] of expected.entries()) {
    const img = /<a href="#client-versions"><img alt="([^"]+)" src="(https:\/\/img\.shields\.io\/badge\/[^"]+)">/.exec(lines[i]);
    assert.ok(img, `missing ${label} badge at position ${i + 1}`);
    assert.equal(img[1], `${label} ${value}`);
    assert.equal(decodeURIComponent(new URL(img[2]).pathname).replace(/-[\da-f]{6}$/i, ''), `/badge/${label}-${value}`);
  }
  const tableNote = note ? (lang === 'zh' ? `（${note}）` : ` (${note})`) : '';
  const row = page.split('\n').find(line => line.startsWith('| Windows x64 |'));
  assert.equal(row, `| Windows x64 | [${observed}](https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand)${tableNote} | ${needs(data.win.version, older)} |`);
}

test('the official installer of the recommended or a fallback release shows no warning', async () => {
  const data = await fixtureData();
  for (const lang of Object.keys(copy)) assertWindows(render(fixture,lang,data), lang, '1.1.0', data);
  data.snap.windows = { ...data.snap.windows, version: '0.71.2', observedArchiveSha256: 'b'.repeat(64) };
  for (const lang of Object.keys(copy)) assertWindows(render(fixture,lang,data), lang, '0.71.2', data);
});

test('a newer release, a repack or a fingerprint mismatch is marked unsupported', async () => {
  const data = await fixtureData();
  const cases = [{ version: '1.2.0' }, { observedArchiveSha256: '0'.repeat(64) }, { observedArchiveSha256: undefined },
    { version: '0.71.2' } /* the recommended release's bytes under the fallback's number */];
  for (const change of cases) {
    const changed = { ...data, snap: { ...data.snap, windows: { ...data.snap.windows, ...change } } };
    for (const [lang, { unsupported }] of Object.entries(copy))
      assertWindows(render(fixture,lang,changed), lang, changed.snap.windows.version, changed, unsupported);
  }
});

test('without a fallback the patch shows a single accepted Windows release', async () => {
  const data = await fixtureData();
  data.winFallback = []; data.androidFallback = [];
  for (const lang of Object.keys(copy)) {
    const page = render(fixture,lang,data);
    assertWindows(page, lang, '1.1.0', data);
    assert.ok(!page.split('\n').some(line => /^\| (Windows|Android)/.test(line) && line.includes('0.71.2')));
  }
});

test('Android names its interface release and fallback; Mac and Linux note a newer official release', async () => {
  const data = await fixtureData();
  data.android = { ...data.android, desktopVersion: '1.1.0' }; data.androidFallback = ['0.71.2'];
  data.mac = { ...data.mac, version: '0.71.2' }; data.snap.mac = { ...data.snap.mac, version: '1.1.0' };
  data.linux = { ...data.linux, version: '1.3.0', archive: { ...data.linux.archive, sha256: 'c'.repeat(64) } };
  data.linuxArm64 = { ...data.linuxArm64, version: '1.3.0' };
  data.snap.linux = { ...data.snap.linux, version: '1.4.0', observedArchiveSha256: 'd'.repeat(64) };
  const zh = render(fixture,'zh',data), en = render(fixture,'en',data);
  assert.ok(zh.includes('界面取自 Windows **1.1.0** 安装包（推荐；用不了再用 0.71.2）'));
  assert.ok(en.includes('interface taken from the Windows **1.1.0** installer (recommended; 0.71.2 if it does not work)'));
  assert.ok(zh.includes('| 网页版（浏览器，非官方） | 不用安装 | 界面取自 Windows **1.1.0** 安装包（推荐；用不了再用 0.71.2），生成后上传到你的 Host |'));
  assert.ok(en.includes('| Web client (browser, unofficial) | Nothing to install | Interface taken from the Windows **1.1.0** installer ' +
    '(recommended; 0.71.2 if it does not work), built once and uploaded to your Host |'));
  assert.ok(zh.includes('| 0.71.2（尚未适配 1.1.0；未在 Mac 真机上测试） |'));
  assert.ok(en.includes('| 0.71.2 (not yet adapted to 1.1.0; not tested on a Mac) |'));
  assert.ok(zh.includes('| Linux x64 / ARM64 | [1.4.0](https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand)（此补丁不支持） | 1.3.0（尚未适配 1.4.0；.deb 原包；已在 Ubuntu 24.04 x64 的容器（虚拟显示）里实测，原生桌面和 ARM64 未实测） |'));
  assert.ok(en.includes('| Linux x64 / ARM64 | [1.4.0](https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand) (not supported by this patch) | 1.3.0 (not yet adapted to 1.4.0; .deb archive; tested on Ubuntu 24.04 x64 in a container with a virtual display; native desktops and ARM64 untested) |'));
  data.snap.mac.version = '0.71.2';
  assert.ok(render(fixture,'en',data).includes('| 0.71.2 (not tested on a Mac) |'));
});

test('a Linux or Intel Mac pin newer than the last real-machine test says it is untested', async () => {
  const data = await fixtureData();
  data.linux = { ...data.linux, version: '1.4.0' }; data.linuxArm64 = { ...data.linuxArm64, version: '1.4.0' };
  data.macIntel = { ...data.macIntel, version: '1.3.0' };
  data.snap.linux = { ...data.snap.linux, version: '1.4.0' }; data.snap.mac = { ...data.snap.mac, version: '1.3.0' };
  const zh = render(fixture,'zh',data), en = render(fixture,'en',data);
  assert.ok(zh.includes(' | 1.4.0（.deb 原包；1.4.0 尚未实测；1.3.0 曾在 Ubuntu 24.04 x64 的容器（虚拟显示）里实测，原生桌面和 ARM64 未实测） |'));
  assert.ok(en.includes(' | 1.4.0 (.deb archive; 1.4.0 not yet tested; 1.3.0 was tested on Ubuntu 24.04 x64 in a container with a virtual display; native desktops and ARM64 untested) |'));
  assert.ok(zh.includes(' | 1.3.0（1.3.0 未在 Mac 真机上测试；1.2.3 曾在 Intel Mac 上实测可用） |'));
  assert.ok(en.includes(' | 1.3.0 (1.3.0 not tested on a Mac; 1.2.3 was tested working on an Intel Mac) |'));
  data.macIntel.version = '1.2.3';
  assert.ok(en.includes('Intel') && render(fixture,'en',data).includes(' | 1.2.3 (tested working on an Intel Mac with 1.2.3) |'));
});

test('iOS marks a newer observed App Store release unsupported and reports tested baseline', async () => {
  const data = await fixtureData();
  data.ios = { ...data.ios, version: '1.27.0', build: '29519' };
  data.snap.ios = { ...data.snap.ios, version: '1.28.0' };
  const zh = render(fixture, 'zh', data), en = render(fixture, 'en', data);
  assert.ok(zh.includes('| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026)（此补丁不支持） | 1.27.0（构建 29519；已在 iPad 上验证连接、发消息和 App Intent） |'));
  assert.ok(en.includes('| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026) (not supported by this patch) | 1.27.0 (build 29519; pairing, messaging and App Intents verified on an iPad) |'));
  data.ios = { ...data.ios, version: '1.28.0', build: '29649' };
  const zhNew = render(fixture, 'zh', data), enNew = render(fixture, 'en', data);
  assert.ok(zhNew.includes('| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026) | 1.28.0（构建 29649；1.28.0 尚未完成全部真机回归（仅在 iPhone 上实测部分项目）；1.27.0 曾在 iPad 上验证连接、发消息和 App Intent） |'));
  assert.ok(enNew.includes('| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026) | 1.28.0 (build 29649; 1.28.0 not yet fully live-tested (partial iPhone testing only); 1.27.0 was verified on an iPad for pairing, messaging and App Intents) |'));
});

test('vendor observation does not promote supported client, shell, or cloud inputs', async () => {
  const data = await fixtureData();
  const newer = structuredClone(data); newer.snap.windows.version = '99.2.1'; newer.android.shell.versionName = '2.7.0';
  for (const lang of ['zh','en']) {
    const rendered = render(fixture,lang,newer);
    assertWindows(rendered, lang, '99.2.1', data, copy[lang].unsupported);
    assert.ok(rendered.includes(`**2.7.0**`)); assert.ok(rendered.includes(`Windows **${data.android.desktopVersion}**`));
    assert.ok(rendered.includes(data.host)); assert.ok(rendered.includes(data.box));
    assert.equal(render(rendered,lang,newer),rendered);
    assert.ok(rendered.includes(middle));
    assert.ok(rendered.startsWith('<p>before</p>')); assert.ok(rendered.endsWith('<p>after</p>\n'));
  }
});

test('missing and duplicate markers fail closed without replacing prose', async () => {
  const data = await readVersions();
  for (const bad of [fixture.replace('<!-- client-badges:start -->',''),fixture+fixture])
    assert.throws(()=>render(bad,'zh',data), /missing or duplicate/);
});

test('both public READMEs exactly match their own version matrix', async () => {
  const data = await readVersions();
  for (const [file,lang] of [['README.md','zh'],['README.en.md','en']]) {
    const text=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    assert.equal(render(text,lang,data),text,`${file}: run node ci/homepage-versions.mjs --write`);
  }
});
