import { validateContextPolicy } from './context-policy.mjs';
import { chatReasoning } from './openai-chat.mjs';
import { claudeTraits } from './anthropic-messages.mjs';
export const TIERS = ['routine', 'reasoning', 'expert'];
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Reference levels for well-known model families; a provider catalog overrides them. */
export function effortLevels(model) {
  const id = String(model).toLowerCase();
  if (/deepseek-v4/.test(id)) return ['none', 'low', 'high', 'max'];
  if (/^claude-/.test(id)) {
    const traits = claudeTraits(id);
    if (!traits.known) return [];
    // 'none' turns thinking off where the model allows it.
    return [...(traits.disable === 'never' ? [] : ['none']), ...traits.efforts, ...(traits.budget && !traits.efforts.length ? ['low', 'medium', 'high'] : [])];
  }
  if (/^o[134](?:-|$)/.test(id)) return ['low', 'medium', 'high'];
  if (/^gpt-5(?:-mini|-nano)?$/.test(id)) return ['minimal', 'low', 'medium', 'high'];
  if (/^gpt-5\.1/.test(id)) return ['none', 'low', 'medium', 'high'];
  if (/^gpt-5\.[2-9]/.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh'];
  if (/^grok-4/.test(id)) return ['minimal', 'low', 'medium', 'high', 'xhigh'];
  return [];
}
export function defaultPolicy(model = 'deepseek-v4.1-flash') {
  return { mode: 'manual', effort: 'default', classifierModel: 'jev-latest',
    models: [{ id: model, efforts: effortLevels(model) }],
    routes: Object.fromEntries(TIERS.map(tier => [tier, { model, effort: 'auto' }])) };
}
export function parseModelPolicy(value, model) {
  return value ? JSON.parse(value) : defaultPolicy(model);
}
export function validatePolicy(value, model) {
  const fail = message => { throw new TypeError(message); };
  const policy = value ?? defaultPolicy(model);
  if (!['manual', 'adaptive'].includes(policy.mode)) fail('Invalid routing mode');
  if (!Array.isArray(policy.models) || policy.models.length > 100) fail('Invalid model catalog');
  const models = policy.models.map(item => {
    if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || /[\r\n\0]/.test(item.id)) fail('Invalid model ID');
    if (!Array.isArray(item.efforts) || item.efforts.some(effort => !EFFORTS.includes(effort))) fail('Invalid effort levels');
    const context = validateContextPolicy(item);
    return { id: item.id.trim(), efforts: EFFORTS.filter(effort => item.efforts.includes(effort)),
      ...(item.contextWindowTokens !== undefined || item.summaryThresholdTokens !== undefined ? context : {}) };
  });
  if (new Set(models.map(item => item.id)).size !== models.length) fail('Duplicate model ID');
  if (!models.some(item => item.id === model)) models.unshift({ id: model, efforts: effortLevels(model) });
  const validEffort = (id, effort, auto = false) => {
    const entry = models.find(item => item.id === id);
    if (!entry || !(effort === 'default' || (auto && effort === 'auto') || entry.efforts.includes(effort))) fail(`Unsupported effort for ${id}`);
    return effort;
  };
  const effort = validEffort(model, policy.effort ?? 'default');
  const routes = Object.fromEntries(TIERS.map(tier => {
    const route = policy.routes?.[tier];
    if (!route) fail('Missing task tier');
    return [tier, { model: route.model, effort: validEffort(route.model, route.effort, true) }];
  }));
  const classifierModel = policy.classifierModel ?? 'jev-latest';
  if (typeof classifierModel !== 'string' || !/^jev-[a-zA-Z0-9._-]{1,80}$/.test(classifierModel)) fail('Invalid classifier model');
  return { mode: policy.mode, effort, models, routes, classifierModel };
}
/** OpenAI Chat reasoning parameters; other formats map the level themselves. */
export function reasoningOptions(model, effort) {
  return chatReasoning(model, effort);
}
