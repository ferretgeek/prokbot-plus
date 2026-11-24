import { constructRecoveredModules } from './recovered-modules.mjs';
import { detectSilentToolCallEnding, wrapCreateTurnSettle } from './turn-continuity.mjs';

const memoryFailureTags = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'AbortError', 'TimeoutError']);

function reportMemoryFailure(error) {
  const tag = [error?.code, error?.cause?.code, error?.name].find(value => memoryFailureTags.has(value));
  console.warn(`[memory] Post-turn memory model request failed (${tag ?? 'model error'})`);
}

function memoryExecutor(executor) {
  return {
    appendMessages(messages) { executor.appendMessages(messages); return this; },
    stream(...args) {
      const result = executor.stream(...args);
      // The memory collector catches fullStream failures but never reads the new
      // completion promises created by the Host's usage middleware above the adapter.
      void Promise.all([result.response, result.usage, result.extendedUsage]).catch(reportMemoryFailure);
      return result;
    },
  };
}

export function constructRecoveredHostFlow(library, directory) {
  const original = library.getHostFlowRecoveryBindings();
  if (typeof original.runTurnMemory !== 'function') throw new TypeError('Missing Host flow dependency: runTurnMemory');
  const needsSilentToolDetector = library.hostFlowRecoveryPlan?.modules?.some(
    module => Array.isArray(module.dependencies) && module.dependencies.includes('turnEndedOnSilentToolCalls'),
  );
  if (needsSilentToolDetector && typeof original.turnEndedOnSilentToolCalls !== 'function') {
    throw new TypeError('Missing Host flow dependency: turnEndedOnSilentToolCalls');
  }
  return constructRecoveredModules(library.hostFlowRecoveryPlan, {
    ...original,
    turnEndedOnSilentToolCalls: detectSilentToolCallEnding,
    runTurnMemory(store, progress, session, ...turnArgs) {
      const memorySession = { getExecutor: (...args) => memoryExecutor(session.getExecutor(...args)) };
      return original.runTurnMemory(store, progress, memorySession, ...turnArgs);
    },
  }, directory, 'Host flow', {
    overrides: {
      createTurnSettle: recovered => wrapCreateTurnSettle(recovered),
    },
  });
}

export async function installRecoveredHostFlow(library, directory) {
  const constructed = await constructRecoveredHostFlow(library, directory);
  const bindings = library.installRecoveredHostFlow(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, before engine/Harness construction',
    bindings, modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
