import { join, dirname } from 'node:path';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { JsonStore, writePrivate, readJson } from './storage.mjs';
import { check } from './security.mjs';
import { digest, packageId, validateFiles, textField } from './package-files.mjs';

const LOCALES = ['en', 'zh-CN'];

function optionalLocalized(value, fallback, max, label) {
  if (value === undefined || value === null) return undefined;
  check(typeof value === 'object' && !Array.isArray(value), 400, `Invalid ${label}`);
  const result = {};
  for (const locale of LOCALES) {
    if (value[locale] !== undefined && value[locale] !== '') result[locale] = textField(value[locale], max, label);
  }
  if (!Object.keys(result).length) return undefined;
  return { en: result.en ?? fallback, 'zh-CN': result['zh-CN'] ?? result.en ?? fallback };
}

function sameLocalized(left, right) {
  return Boolean(left && right) && LOCALES.every(locale => left[locale] === right[locale]);
}

function assignLocalized(target, localizedName, localizedDescription) {
  if (localizedName) target.localizedName = { ...localizedName }; else delete target.localizedName;
  if (localizedDescription) target.localizedDescription = { ...localizedDescription }; else delete target.localizedDescription;
}

// Localized copy belongs to the English text it translates; a rename by an older Host or the API drops it.
function localizedCopy({ name, description, localizedName, localizedDescription }) {
  return {
    ...(localizedName?.en === name ? { localizedName: { ...localizedName } } : {}),
    ...(localizedDescription?.en === description ? { localizedDescription: { ...localizedDescription } } : {}),
  };
}

function copyVersionMeta({ id, at, name, description, localizedName, localizedDescription }) {
  return { id, at, name, description, ...localizedCopy({ name, description, localizedName, localizedDescription }) };
}

function copyItem({ versions, localizedName, localizedDescription, ...item }) {
  return {
    ...item,
    ...localizedCopy({ ...item, localizedName, localizedDescription }),
    versions: versions.map(copyVersionMeta),
  };
}

export function validateSkill(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid skill');
  const id = packageId(input.id), name = textField(input.name, 100, 'skill name');
  const description = textField(input.description, 2000, 'skill description');
  const files = validateFiles(input.files);
  const markdown = files.find(file => file.path === 'SKILL.md' && file.encoding === 'utf8');
  check(markdown && markdown.content.trim(), 400, 'SKILL.md is required');
  const requiresTools = input.requiresTools ?? [];
  check(Array.isArray(requiresTools) && requiresTools.length <= 100 && requiresTools.every(tool =>
    typeof tool === 'string' && /^[A-Za-z][\w.-]{0,199}$/.test(tool)), 400, 'Invalid tool dependencies');
  return { id, name, description, files, requiresTools: [...new Set(requiresTools)] };
}

export class Skills {
  constructor(dataDir, { hostDataDir } = {}) {
    this.dataDir = dataDir; this.hostDataDir = hostDataDir;
    this.store = new JsonStore(join(dataDir, 'skill-catalog.json'), { version: 1, skills: [], revision: 0 });
  }
  async load() { await this.store.load(); return this; }
  list() { return this.store.value.skills.map(copyItem); }
  get(id, version) {
    const item = this.store.value.skills.find(item => item.id === id);
    check(item, 404, 'Skill not found');
    const content = item.versions.find(entry => entry.id === (version ?? item.current));
    check(content, 404, 'Skill version not found');
    const { localizedName, localizedDescription, ...rest } = content;
    return { ...copyItem(item), content: { ...rest, ...localizedCopy(content) } };
  }
  /** Seed a built-in Host skill once, or backfill its localization on existing unmodified entries.
   *  Existing entries are not read back, so a damaged entry cannot stop the admin service at startup. */
  async seed(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid skill');
    const id = packageId(input.id);
    const existing = this.store.value.skills.find(item => item.id === id);
    if (!existing) { await this.publish(input, 'host'); return; }
    if (existing.source !== 'host') return;
    const name = textField(input.name, 100, 'skill name');
    const description = textField(input.description, 2000, 'skill description');
    const localizedName = optionalLocalized(input.localizedName, name, 100, 'skill name');
    const localizedDescription = optionalLocalized(input.localizedDescription, description, 2000, 'skill description');
    const needsUpdate = target =>
      (localizedName && target.name === name && !sameLocalized(target.localizedName, localizedName)) ||
      (localizedDescription && target.description === description && !sameLocalized(target.localizedDescription, localizedDescription));
    if (!needsUpdate(existing) && !existing.versions.some(needsUpdate)) return;
    await this.store.mutate(state => {
      const item = state.skills.find(entry => entry.id === id);
      if (!item || item.source !== 'host') return;
      let changed = false;
      const apply = target => {
        if (localizedName && target.name === name && !sameLocalized(target.localizedName, localizedName)) {
          target.localizedName = { ...localizedName }; changed = true;
        }
        if (localizedDescription && target.description === description && !sameLocalized(target.localizedDescription, localizedDescription)) {
          target.localizedDescription = { ...localizedDescription }; changed = true;
        }
      };
      apply(item);
      for (const version of item.versions) apply(version);
      if (changed) state.revision++;
    });
  }
  async publish(input, source = 'host') {
    const content = validateSkill(input), revision = digest(JSON.stringify(content));
    const inputLocalizedName = optionalLocalized(input.localizedName, content.name, 100, 'skill name');
    const inputLocalizedDescription = optionalLocalized(input.localizedDescription, content.description, 2000, 'skill description');
    await this.store.mutate(state => {
      let item = state.skills.find(item => item.id === content.id);
      if (!item) {
        item = { id: content.id, source, enabled: input.enabled !== false, baseline: revision, current: revision, versions: [] };
        state.skills.push(item);
      }
      check(item.source === source, 409, 'Skill belongs to another source');
      let version = item.versions.find(entry => entry.id === revision);
      const localizedName = inputLocalizedName
        ?? (content.name === item.name ? item.localizedName : undefined)
        ?? (version?.name === content.name ? version.localizedName : undefined);
      const localizedDescription = inputLocalizedDescription
        ?? (content.description === item.description ? item.localizedDescription : undefined)
        ?? (version?.description === content.description ? version.localizedDescription : undefined);
      if (!version) {
        version = { ...content, id: revision, at: Date.now() };
        item.versions.push(version);
      }
      assignLocalized(version, localizedName, localizedDescription);
      item.previous = item.current === revision ? item.previous : item.current;
      item.current = revision; item.name = content.name; item.description = content.description;
      assignLocalized(item, localizedName, localizedDescription);
      if (typeof input.enabled === 'boolean') item.enabled = input.enabled;
      state.revision++;
    });
    return this.get(content.id);
  }
  async update(id, { enabled, restore }) {
    await this.store.mutate(state => {
      const item = state.skills.find(item => item.id === id); check(item, 404, 'Skill not found');
      check(item.source === 'host', 409, 'Manage bundled skills through their plugin');
      if (enabled !== undefined) { check(typeof enabled === 'boolean', 400, 'Invalid enabled state'); item.enabled = enabled; }
      if (restore) {
        const target = restore === 'baseline' ? item.baseline : restore === 'previous' ? item.previous : restore;
        const version = item.versions.find(version => version.id === target); check(version, 404, 'Skill version not found');
        item.previous = item.current; item.current = target; item.name = version.name; item.description = version.description;
        assignLocalized(item, version.localizedName, version.localizedDescription);
      }
      state.revision++;
    });
    return this.get(id);
  }
  async setSourceEnabled(source, enabled) {
    await this.store.mutate(state => { for (const item of state.skills) if (item.source === source) item.enabled = enabled; state.revision++; });
  }
  async replaceSource(source, inputs) {
    check(source.startsWith('plugin:'), 400, 'Invalid skill source');
    const contents = inputs.map(input => {
      const content = validateSkill(input);
      return {
        content,
        enabled: input.enabled === true,
        localizedName: optionalLocalized(input.localizedName, content.name, 100, 'skill name'),
        localizedDescription: optionalLocalized(input.localizedDescription, content.description, 2000, 'skill description'),
      };
    });
    await this.store.mutate(state => {
      for (const item of state.skills) if (item.source === source) item.enabled = false;
      for (const { content, enabled, localizedName, localizedDescription } of contents) {
        const revision = digest(JSON.stringify(content));
        let item = state.skills.find(item => item.id === content.id);
        if (!item) { item = { id: content.id, source, baseline: revision, current: revision, versions: [] }; state.skills.push(item); }
        check(item.source === source, 409, 'Skill belongs to another source');
        let version = item.versions.find(version => version.id === revision);
        if (!version) { version = { ...content, id: revision, at: Date.now() }; item.versions.push(version); }
        assignLocalized(version, localizedName, localizedDescription);
        item.previous = item.current === revision ? item.previous : item.current;
        Object.assign(item, { current: revision, name: content.name, description: content.description, enabled });
        assignLocalized(item, localizedName, localizedDescription);
      }
      state.revision++;
    });
  }
  async remove(id) {
    await this.store.mutate(state => {
      const item = state.skills.find(item => item.id === id); check(item, 404, 'Skill not found');
      check(item.source === 'host', 409, 'Manage bundled skills through their plugin');
      state.skills = state.skills.filter(item => item.id !== id); state.revision++;
    });
    return { ok: true };
  }
}

/** Publish complete version directories first, then atomically expose an original-format index. */
export async function materializeSkills(dataDir, hostDataDir) {
  const catalog = await readJson(join(dataDir, 'skill-catalog.json'), { skills: [], revision: 0 });
  const cacheDir = join(hostDataDir, 'managed-skills'), skills = [];
  await mkdir(cacheDir, { recursive: true, mode: 0o755 });
  for (const item of catalog.skills.filter(item => item.enabled)) {
    const current = item.versions.find(version => version.id === item.current);
    // Stable catalog identity; immutable file paths keep in-flight reads on their selected version.
    const directory = join(cacheDir, 'skills', `${item.id}-${item.current.slice(0, 12)}`);
    for (const file of current.files) {
      const filename = join(directory, file.path);
      await mkdir(dirname(filename), { recursive: true, mode: 0o755 });
      const expected = Buffer.from(file.content, file.encoding);
      const previous = await readFile(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!previous || !previous.equals(expected)) { await writePrivate(filename, expected); await chmod(filename, 0o444); }
    }
    const source = current.files.find(file => file.path === 'SKILL.md').content;
    skills.push({ id: item.id, name: current.name, description: current.description,
      body: source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), source: item.source,
      filePath: join(directory, 'SKILL.md'), requiresTools: current.requiresTools, revision: item.current });
  }
  const previous = await readJson(join(cacheDir, 'cache.json'), null);
  if (JSON.stringify(previous?.skills) === JSON.stringify(skills)) return { revision: catalog.revision, skills };
  const index = { fetchedAt: Date.now(), skills };
  await writePrivate(join(cacheDir, 'cache.json'), JSON.stringify(index));
  return { revision: catalog.revision, skills };
}
