import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installLocalPromptPolicy } from '../runtime/prompt-runtime.mjs';

test('parent prompts preserve proactive memory retrieval and reject stale access conclusions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-runtime-'));
  const previous = globalThis.__grokbotPromptPolicy;
  const runtime = await installLocalPromptPolicy(directory, {}, {
    pollMs: 60_000, memoryRoot: '/data/runtime/host-data/', memoryMounts: true,
  });
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete globalThis.__grokbotPromptPolicy;
    else globalThis.__grokbotPromptPolicy = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const render = globalThis.__grokbotPromptPolicy.snapshot();
  const parent = render('parent', 'Original parent prompt');
  assert.match(parent, /^Original parent prompt\n\nMemory access is configured for this turn:/);
  assert.match(parent, /agent memory is mounted read-only at \/data\/runtime\/host-data\/agents/);
  assert.match(parent, /shared user memory at \/data\/runtime\/host-data\/user-memory/);
  assert.match(parent, /Use memory proactively whenever it can affect the answer, without waiting for the user to ask/);
  assert.match(parent, /when you need older or omitted facts, inspect the corresponding files with Read or Shell/);
  assert.match(parent, /These mounts are read-only: do not try to create, edit or delete files under them/);
  assert.match(parent, /Do not repeat an earlier turn's "not mounted" or "not readable" result/);
  assert.match(parent, /A missing monthly log means that no file has been recorded for that month yet/);
  assert.doesNotMatch(parent, /When asked to read, search, audit, clean, or summarize memory/);
  assert.equal(render('automation', 'Original automation prompt'), 'Original automation prompt');
});

test('remote execution topologies do not receive the local memory directive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-runtime-'));
  const previous = globalThis.__grokbotPromptPolicy;
  const runtime = await installLocalPromptPolicy(directory, {}, { pollMs: 60_000, memoryMounts: false });
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete globalThis.__grokbotPromptPolicy;
    else globalThis.__grokbotPromptPolicy = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const render = globalThis.__grokbotPromptPolicy.snapshot();
  assert.equal(render('parent', 'Original parent prompt'), 'Original parent prompt');
});

test('an almost-full parent prompt falls back when the memory directive would exceed the limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-runtime-'));
  const previous = globalThis.__grokbotPromptPolicy;
  const runtime = await installLocalPromptPolicy(directory, {}, {
    pollMs: 60_000, memoryRoot: '/data/runtime/host-data', memoryMounts: true,
  });
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete globalThis.__grokbotPromptPolicy;
    else globalThis.__grokbotPromptPolicy = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const original = `Memory prompt\n${'x'.repeat(199_900)}`;
  assert.ok(Buffer.byteLength(original) < 200_000);
  const render = globalThis.__grokbotPromptPolicy.snapshot();
  assert.equal(render('parent', original), original);
});
