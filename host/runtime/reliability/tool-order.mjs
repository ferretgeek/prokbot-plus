// Messages from one model response must reach the user in the order the model wrote them.
// The model layer hands the Harness a response's tool calls together, and the Harness then
// runs them concurrently (each first awaits its own durable journal admission), so without
// this the shortest message tends to arrive first. Other tools keep running in parallel.

const ORDERED_TOOLS = new Set(['SendToUser', 'SendToAgent']);
// A predecessor that never executes (for example, rejected arguments) must not block forever.
const MAX_WAIT_MS = 15_000;
const STALE_MS = 10 * 60_000;
const calls = new Map();

function sweep(now) {
  for (const [id, entry] of calls) if (now - entry.createdAt > STALE_MS) { entry.resolve(); calls.delete(id); }
}

/** Called by the model layer with one response's tool calls in written order. */
export function recordToolCallOrder(list) {
  const now = Date.now();
  sweep(now);
  let previous;
  for (const { toolCallId, toolName } of list) {
    if (!ORDERED_TOOLS.has(toolName) || typeof toolCallId !== 'string' || !toolCallId) continue;
    let resolve;
    const done = new Promise(settle => { resolve = settle; });
    calls.set(toolCallId, { previous, done, resolve, createdAt: now });
    previous = toolCallId;
  }
}

/** Wait for the previous ordered call of the same response; the returned function marks this call finished. */
export async function awaitToolCallTurn(toolCallId, signal, { maxWaitMs = MAX_WAIT_MS } = {}) {
  const entry = calls.get(toolCallId);
  if (!entry) return () => {};
  const previous = entry.previous === undefined ? undefined : calls.get(entry.previous);
  if (previous && !signal?.aborted) {
    let timer, onAbort;
    await Promise.race([previous.done,
      new Promise(settle => { timer = setTimeout(settle, maxWaitMs); timer.unref?.(); }),
      new Promise(settle => { onAbort = settle; signal?.addEventListener('abort', settle, { once: true }); })]);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return () => { entry.resolve(); if (calls.get(toolCallId) === entry) calls.delete(toolCallId); };
}
