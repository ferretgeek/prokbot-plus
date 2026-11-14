import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readVersions, render } from './homepage-versions.mjs';

const fixture = '<p>before</p>\n<!-- client-badges:start -->\n<!-- client-badges:end -->\n<!-- client-versions:start -->\n<!-- client-versions:end -->\n<p>after</p>\n';
test('vendor observation does not promote supported client, shell, or cloud inputs', async () => {
  const data = await readVersions();
  const newer = structuredClone(data); newer.snap.windows.version = '99.2.1'; newer.android.shell.versionName = '2.7.0';
  for (const lang of ['zh','en']) {
    const rendered = render(fixture,lang,newer);
    assert.match(rendered, /\| Windows x64 \| \[99\.2\.1\]/);
    assert.ok(rendered.includes(`sand) | ${data.win.version} |`));
    assert.ok(rendered.includes(`**2.7.0**`)); assert.ok(rendered.includes(`Windows **${data.android.desktopVersion}**`));
    assert.ok(rendered.includes(data.host)); assert.ok(rendered.includes(data.box));
    assert.equal(render(rendered,lang,newer),rendered);
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
