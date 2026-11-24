import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Skills, materializeSkills } from '../server/skills.mjs';
import { validatePlugin, bundledSkills } from '../server/plugin-package.mjs';
import { Connectors } from '../server/connectors.mjs';
import { Plugins } from '../server/plugins.mjs';
import { Sharing, localExportSkill } from '../server/sharing.mjs';
import { provisionTeachSkill } from '../runtime/host-teach.mjs';

async function tempDir(t, prefix = 'grokbot-skills-i18n-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const sampleAppPackage = {
  schemaVersion: 1,
  kind: 'grokbot-app',
  id: 'demo-vault',
  version: '1.0.0',
  name: { en: 'Demo Vault', 'zh-CN': '演示密码库' },
  description: { en: 'Demo password vault app.', 'zh-CN': '演示密码库应用。' },
  runtime: { kind: 'skills-only' },
  skills: [{
    id: 'safe-login',
    path: 'skills/safe-login/SKILL.md',
    name: { en: 'Demo Vault Safe Login', 'zh-CN': '演示密码库安全登录' },
    description: {
      en: 'Look up accounts and sign in safely with approval cards.',
      'zh-CN': '查询账号并配合审批卡片安全登录。',
    },
    requiresTools: [],
  }],
  files: [{
    path: 'skills/safe-login/SKILL.md',
    encoding: 'utf8',
    content: '# Demo Vault Safe Login\n\nUse demo vault safely.\n',
  }],
};

test('bundledSkills preserves localized skill copy alongside canonical English fields', () => {
  const pkg = validatePlugin(sampleAppPackage);
  const items = bundledSkills(pkg, false);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Demo Vault Safe Login');
  assert.equal(items[0].description, 'Look up accounts and sign in safely with approval cards.');
  assert.deepEqual(items[0].localizedName, {
    en: 'Demo Vault Safe Login',
    'zh-CN': '演示密码库安全登录',
  });
  assert.deepEqual(items[0].localizedDescription, {
    en: 'Look up accounts and sign in safely with approval cards.',
    'zh-CN': '查询账号并配合审批卡片安全登录。',
  });
});

test('Plugins sync propagates and backfills localized bundled skills without altering revisions or cache.json', async t => {
  const dataDir = await tempDir(t);
  const hostDataDir = join(dataDir, 'host-data');
  const skills = await new Skills(dataDir, { hostDataDir }).load();
  const connectors = await new Connectors(dataDir).load();
  t.after(() => connectors.close());
  const plugins = await new Plugins(dataDir, { connectors, skills }).load();

  await plugins.publish(sampleAppPackage);
  const bundled = skills.list().find(item => item.source === 'plugin:demo-vault');
  assert.ok(bundled);
  assert.equal(bundled.enabled, false);
  assert.equal(bundled.name, 'Demo Vault Safe Login');
  assert.deepEqual(bundled.localizedName, {
    en: 'Demo Vault Safe Login',
    'zh-CN': '演示密码库安全登录',
  });
  assert.deepEqual(bundled.localizedDescription, {
    en: 'Look up accounts and sign in safely with approval cards.',
    'zh-CN': '查询账号并配合审批卡片安全登录。',
  });
  const originalRevision = bundled.current;

  // Simulate an older Host upgrade whose skill-catalog.json lacks localizedName/localizedDescription.
  const catalogPath = join(dataDir, 'skill-catalog.json');
  const legacyCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  for (const item of legacyCatalog.skills) {
    delete item.localizedName;
    delete item.localizedDescription;
    for (const version of item.versions) {
      delete version.localizedName;
      delete version.localizedDescription;
    }
  }
  await writeFile(catalogPath, JSON.stringify(legacyCatalog, null, 2));

  const reloadedSkills = await new Skills(dataDir, { hostDataDir }).load();
  const reloadedConnectors = await new Connectors(dataDir).load();
  t.after(() => reloadedConnectors.close());
  await new Plugins(dataDir, { connectors: reloadedConnectors, skills: reloadedSkills }).load();

  const backfilled = reloadedSkills.get(bundled.id);
  assert.equal(backfilled.current, originalRevision);
  assert.deepEqual(backfilled.localizedName, {
    en: 'Demo Vault Safe Login',
    'zh-CN': '演示密码库安全登录',
  });
  assert.deepEqual(backfilled.localizedDescription, {
    en: 'Look up accounts and sign in safely with approval cards.',
    'zh-CN': '查询账号并配合审批卡片安全登录。',
  });

  // Enable and verify materializeSkills still emits plain strings for the runtime.
  await reloadedSkills.setSourceEnabled('plugin:demo-vault', true);
  const materialized = await materializeSkills(dataDir, hostDataDir);
  const entry = materialized.skills.find(item => item.id === bundled.id);
  assert.equal(entry.name, 'Demo Vault Safe Login');
  assert.equal(entry.description, 'Look up accounts and sign in safely with approval cards.');
  assert.equal(entry.revision, originalRevision);
});

test('built-in Host skills seed with zh-CN/en copy and safely backfill legacy catalogs on upgrade', async t => {
  const dataDir = await tempDir(t);
  const hostDataDir = join(dataDir, 'host-data');
  const skills = await new Skills(dataDir, { hostDataDir }).load();

  // Seed a legacy catalog without localization, with one disabled/edited skill and one renamed skill.
  const teachBaseline = await skills.publish({
    id: 'learn-from-demonstration',
    name: 'Learn from demonstration',
    description: 'Turn a recorded task into a reusable skill.',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Custom edited teach skill\n' }],
    enabled: false,
    requiresTools: [],
  });
  await skills.publish({
    id: localExportSkill.id,
    name: localExportSkill.name,
    description: localExportSkill.description,
    files: localExportSkill.files,
    enabled: true,
    requiresTools: [],
  });
  await skills.publish({
    id: localExportSkill.id,
    name: 'My Custom Export Skill',
    description: localExportSkill.description,
    files: localExportSkill.files,
    enabled: true,
    requiresTools: [],
  });

  await provisionTeachSkill(skills);
  await new Sharing(dataDir, { skills }).load();

  const teach = skills.get('learn-from-demonstration');
  assert.equal(teach.enabled, false);
  assert.equal(teach.current, teachBaseline.current);
  assert.equal(teach.content.files.find(file => file.path === 'SKILL.md').content, '# Custom edited teach skill\n');
  assert.deepEqual(teach.localizedName, {
    en: 'Learn from demonstration',
    'zh-CN': '从演示中学习',
  });
  assert.deepEqual(teach.localizedDescription, {
    en: 'Turn a recorded task into a reusable skill.',
    'zh-CN': '将录制的操作整理为可复用的技能。',
  });

  // Renamed export skill keeps its custom title while backfilling the unchanged description and baseline version.
  const exported = skills.get('export-bot-template');
  assert.equal(exported.name, 'My Custom Export Skill');
  assert.equal(exported.localizedName, undefined);
  assert.deepEqual(exported.localizedDescription, {
    en: 'Prepare a reusable Bot recipe for review and publishing to this Host.',
    'zh-CN': '准备可复用的 Bot 模板，供审核并发布到此 Host。',
  });

  // Second boot is a no-op (no revision bump).
  const revisionBefore = skills.store.value.revision;
  await provisionTeachSkill(skills);
  await new Sharing(dataDir, { skills }).load();
  assert.equal(skills.store.value.revision, revisionBefore);

  // Restoring baseline brings back the localized built-in title.
  const restored = await skills.update('export-bot-template', { restore: 'baseline' });
  assert.equal(restored.name, 'Export Bot template');
  assert.deepEqual(restored.localizedName, {
    en: 'Export Bot template',
    'zh-CN': '导出 Bot 模板',
  });
});

test('editing a localized skill preserves localization until name/description changes and validates inputs', async t => {
  const dataDir = await tempDir(t);
  const skills = await new Skills(dataDir).load();
  await provisionTeachSkill(skills);

  // Editing only SKILL.md keeps localizedName and localizedDescription.
  const editedMarkdown = await skills.publish({
    id: 'learn-from-demonstration',
    name: 'Learn from demonstration',
    description: 'Turn a recorded task into a reusable skill.',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Updated instructions\n' }],
    requiresTools: [],
  });
  assert.deepEqual(editedMarkdown.localizedName, {
    en: 'Learn from demonstration',
    'zh-CN': '从演示中学习',
  });
  assert.deepEqual(editedMarkdown.localizedDescription, {
    en: 'Turn a recorded task into a reusable skill.',
    'zh-CN': '将录制的操作整理为可复用的技能。',
  });

  // Renaming clears localizedName while keeping localizedDescription.
  const renamed = await skills.publish({
    id: 'learn-from-demonstration',
    name: 'Custom Demonstration Skill',
    description: 'Turn a recorded task into a reusable skill.',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Updated instructions\n' }],
    requiresTools: [],
  });
  assert.equal(renamed.localizedName, undefined);
  assert.deepEqual(renamed.localizedDescription, {
    en: 'Turn a recorded task into a reusable skill.',
    'zh-CN': '将录制的操作整理为可复用的技能。',
  });

  // Restoring previous version restores localizedName.
  const restoredPrevious = await skills.update('learn-from-demonstration', { restore: 'previous' });
  assert.deepEqual(restoredPrevious.localizedName, {
    en: 'Learn from demonstration',
    'zh-CN': '从演示中学习',
  });

  // Partial localized objects fill en from canonical name and ignore unknown locale keys.
  const custom = await skills.publish({
    id: 'custom-localized',
    name: 'Custom Skill',
    description: 'Custom description.',
    localizedName: { 'zh-CN': '自定义技能', fr: 'Ignored' },
    localizedDescription: { 'zh-CN': '自定义简介。' },
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Custom\n' }],
    requiresTools: [],
  });
  assert.deepEqual(custom.localizedName, { en: 'Custom Skill', 'zh-CN': '自定义技能' });
  assert.deepEqual(custom.localizedDescription, { en: 'Custom description.', 'zh-CN': '自定义简介。' });

  // Invalid localized payloads fail with HTTP 400.
  for (const invalid of ['string', ['array'], { 'zh-CN': '   ' }, { en: 'x'.repeat(101) }]) {
    await assert.rejects(
      skills.publish({
        id: 'bad-localized',
        name: 'Bad',
        description: 'Bad',
        localizedName: invalid,
        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Bad\n' }],
      }),
      error => error.status === 400,
    );
  }
});

test('public i18n localizedText resolves zh-CN and en skill copy with fallback', async t => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });

  const sample = { en: 'Learn from demonstration', 'zh-CN': '从演示中学习' };

  Object.defineProperty(globalThis, 'document', { value: { documentElement: { lang: '' } }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['zh-CN'], language: 'zh-CN' }, configurable: true });
  const zh = await import('../server/public/i18n.js?test=zh');
  assert.equal(zh.locale, 'zh-CN');
  assert.equal(zh.localizedText(sample, 'Learn from demonstration'), '从演示中学习');
  assert.equal(zh.localizedText(undefined, 'Custom Skill'), 'Custom Skill');

  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US' }, configurable: true });
  const en = await import('../server/public/i18n.js?test=en');
  assert.equal(en.locale, 'en');
  assert.equal(en.localizedText(sample, 'Learn from demonstration'), 'Learn from demonstration');
  assert.equal(en.localizedText({ 'zh-CN': '仅中文' }, 'English fallback'), 'English fallback');
  assert.equal(en.localizedText(undefined, 'Custom Skill'), 'Custom Skill');
});

test('localized copy shows only for the English text it translates, and seeding never reads entries back', async t => {
  const dataDir = await tempDir(t);
  const skills = await new Skills(dataDir, { hostDataDir: join(dataDir, 'host-data') }).load();
  await skills.seed(localExportSkill);
  // An older Host renames the skill without knowing about localization.
  await skills.store.mutate(state => {
    const item = state.skills.find(entry => entry.id === localExportSkill.id);
    item.name = 'Renamed on an older Host';
    item.versions.find(version => version.id === item.current).name = 'Renamed on an older Host';
  });
  const listed = skills.list().find(entry => entry.id === localExportSkill.id);
  assert.equal(listed.localizedName, undefined);
  assert.deepEqual(listed.localizedDescription, localExportSkill.localizedDescription);
  assert.equal(skills.get(localExportSkill.id).content.localizedName, undefined);

  // main starts with a dangling current version; seeding must not turn that into a startup failure.
  await skills.store.mutate(state => { state.skills.find(entry => entry.id === localExportSkill.id).current = 'missing'; });
  await skills.seed(localExportSkill);
});
