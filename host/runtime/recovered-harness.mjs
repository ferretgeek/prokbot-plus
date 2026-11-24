import { constructRecoveredModules } from './recovered-modules.mjs';
import { wrapAnysphereAgent, wrapCreateTurnAgentComposition } from './turn-continuity.mjs';

export function constructRecoveredHarness(library, directory) {
  const original = library.getHarnessRecoveryBindings();
  if (typeof original.AnysphereAgent !== 'function') {
    throw new TypeError('Missing Harness dependency: AnysphereAgent');
  }
  const bindings = {
    ...original,
    AnysphereAgent: wrapAnysphereAgent(original.AnysphereAgent),
  };
  return constructRecoveredModules(library.harnessRecoveryPlan, bindings, directory, 'Harness', {
    overrides: {
      createTurnAgentComposition: recovered => wrapCreateTurnAgentComposition(recovered),
    },
  });
}

export async function installRecoveredHarness(library, directory) {
  const constructed = await constructRecoveredHarness(library, directory);
  const bindings = library.installRecoveredHarness(constructed.bindings);
  return { installed: true, factoryLifetime: 'One instance of each module per Host process',
    bindings, modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
