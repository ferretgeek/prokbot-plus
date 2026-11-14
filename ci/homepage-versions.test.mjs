import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readVersions, render } from './homepage-versions.mjs';

const middle = '<!-- client-badges:end -->\r\n<p>unrelated edit</p>\r\n<!-- client-versions:start -->';
const fixture = `<p>before</p>\n<!-- client-badges:start -->\n${middle}\n<!-- client-versions:end -->\n<p>after</p>\n`;
const windowsCopy = {
  zh: { official: 'Windows 官方', input: 'Windows 补丁仅接受', incompatible: '与此补丁不兼容',
    unsupported: '此补丁不支持', rejected: '补丁在输入校验时拒绝了该安装包；未测试原生客户端聊天' },
  en: { official: 'Windows official', input: 'Windows patch accepts only', incompatible: 'incompatible with this patch',
    unsupported: 'not supported by this patch', rejected: 'installer rejected during input verification; no native chat test' },
};

// Keep the historical test case independent of the rolling snapshot and build pins.
async function researchedWindows() {
  const data = await readVersions();
  data.win.version = data.android.desktopVersion = '0.71.2';
  data.win.archive.sha256 = 'be14f2f2067d86334360f5d4f7c94515886ef795df25645aa883d3983c4ab4aa';
  data.snap.windows = { version: '1.1.0', build: '83d46d618ef4c12afa17edd8e3c29d6caf046d17',
    observedArchiveSha256: '01ccb10f2144ea0eb787042c54fc4b8ca2c6f43eccb7dabe5fe5eb86fa5ed044',
    observedAsarSha256: 'ae8f0a14fe65f421881f96fdcb66aaaaed8b28806f79d5239dbefec9ef2ea972' };
  return data;
}

function assertWindows(page, lang, observed, accepted, badgeNote = '', tableNote = badgeNote) {
  const lines = page.split('<!-- client-badges:start -->')[1].split('<!-- client-badges:end -->')[0].trim().split('\n');
  const { official, input } = windowsCopy[lang];
  const expected = [[official, `${observed} x64${badgeNote ? ` (${badgeNote})` : ''}`], [input, `${accepted} x64`]];
  for (const [i, [label, value]] of expected.entries()) {
    const img = /<a href="#client-versions"><img alt="([^"]+)" src="(https:\/\/img\.shields\.io\/badge\/[^"]+)">/.exec(lines[i]);
    assert.ok(img, `missing ${label} badge at position ${i + 1}`);
    assert.equal(img[1], `${label} ${value}`);
    assert.equal(decodeURIComponent(new URL(img[2]).pathname).replace(/-[\da-f]{6}$/i, ''), `/badge/${label}-${value}`);
  }
  const note = tableNote ? (lang === 'zh' ? `（${tableNote}）` : ` (${tableNote})`) : '';
  const row = page.split('\n').find(line => line.startsWith('| Windows x64 |'));
  assert.equal(row, `| Windows x64 | [${observed}](https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand)${note} | ${accepted} |`);
}

test('the researched Windows installer is incompatible with the pinned patch, not a failed native chat test', async () => {
  const data = await researchedWindows();
  for (const [lang, copy] of Object.entries(windowsCopy))
    assertWindows(render(fixture,lang,data), lang, '1.1.0', '0.71.2', copy.incompatible, copy.rejected);
});

test('matching official and accepted versions show both badges without rejection or a runtime claim', async () => {
  const data = await researchedWindows();
  for (const version of ['1.1.0','99.2.1']) {
    data.win.version = data.snap.windows.version = data.android.desktopVersion = version;
    data.win.archive.sha256 = data.snap.windows.observedArchiveSha256;
    for (const lang of Object.keys(windowsCopy)) assertWindows(render(fixture,lang,data), lang, version, version);
  }
});

test('a different build, repack, source fingerprint or patch pin does not inherit the researched verdict', async () => {
  const data = await researchedWindows();
  const observations = [{ build: '0'.repeat(40) }, { observedArchiveSha256: '0'.repeat(64) },
    { observedAsarSha256: '0'.repeat(64) }, { observedArchiveSha256: undefined }];
  const cases = observations.map(change => ({ ...data, snap: { ...data.snap, windows: { ...data.snap.windows, ...change } } }));
  cases.push({ ...data, win: { ...data.win, version: '0.90.0' } },
    { ...data, win: { ...data.win, archive: { ...data.win.archive, sha256: '0'.repeat(64) } } });
  for (const changed of cases) {
    for (const [lang, copy] of Object.entries(windowsCopy))
      assertWindows(render(fixture,lang,changed), lang, changed.snap.windows.version, changed.win.version, copy.unsupported);
  }
});

test('a repack carrying the supported version number is not advertised as a matching input', async () => {
  const data = await researchedWindows();
  data.snap.windows.version = data.win.version;
  for (const [lang, copy] of Object.entries(windowsCopy))
    assertWindows(render(fixture,lang,data), lang, data.win.version, data.win.version, copy.unsupported);
});

test('vendor observation does not promote supported client, shell, or cloud inputs', async () => {
  const data = await researchedWindows();
  const newer = structuredClone(data); newer.snap.windows.version = '99.2.1'; newer.android.shell.versionName = '2.7.0';
  for (const lang of ['zh','en']) {
    const rendered = render(fixture,lang,newer);
    assertWindows(rendered, lang, '99.2.1', data.win.version, windowsCopy[lang].unsupported);
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
