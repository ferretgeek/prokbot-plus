import { readFile } from 'node:fs/promises';

const teachSkill = {
  id: 'learn-from-demonstration',
  name: 'Learn from demonstration',
  description: 'Turn a recorded task into a reusable skill.',
  localizedName: { en: 'Learn from demonstration', 'zh-CN': '从演示中学习' },
  localizedDescription: { en: 'Turn a recorded task into a reusable skill.', 'zh-CN': '将录制的操作整理为可复用的技能。' },
};

/** Seed once through the existing catalog owner, preserving edits and disable state. */
export async function provisionTeachSkill(skills) {
  if (skills.list().some(skill => skill.id === teachSkill.id)) {
    await skills.seed(teachSkill);
    return;
  }
  const files = await Promise.all(['SKILL.md', 'prepare.py'].map(async path => ({ path, encoding: 'utf8',
    content: await readFile(new URL(`./teach-skill/${path}`, import.meta.url), 'utf8') })));
  await skills.seed({ ...teachSkill, files, enabled: true, requiresTools: [] });
}
