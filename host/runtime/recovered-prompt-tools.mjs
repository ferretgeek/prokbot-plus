import { constructRecoveredModules } from './recovered-modules.mjs';
import {
  readAutoReviewClassifierMaxAttempts,
  wrapSandShellAutoReviewTargetEnrichment,
} from './shell-auto-review-enrichment.mjs';

export function enhancePromptToolsBindings(original, computer = {}, env = process.env) {
  const enhanced = { ...original };
  if (typeof original?.buildSandShellAutoReviewTargetEnrichment === 'function') {
    enhanced.buildSandShellAutoReviewTargetEnrichment = wrapSandShellAutoReviewTargetEnrichment(
      original.buildSandShellAutoReviewTargetEnrichment,
      {
        shellExecutorResource: original.shellExecutorResource ?? computer.shellExecutorResource,
        buildHostShellArgs: computer.buildHostShellArgs,
      },
    );
  }
  if (typeof original?.SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS === 'number') {
    enhanced.SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = readAutoReviewClassifierMaxAttempts(
      env,
      Math.max(2, original.SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS),
    );
  }
  return enhanced;
}

export async function installRecoveredPromptTools(library, directory) {
  const original = library.getPromptToolsRecoveryBindings();
  const computer = typeof library.getComputerRecoveryBindings === 'function'
    ? library.getComputerRecoveryBindings()
    : {};
  const constructed = await constructRecoveredModules(library.promptToolsRecoveryPlan,
    enhancePromptToolsBindings(original, computer), directory, 'Prompt/tools');
  const bindings = library.installRecoveredPromptTools(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, after Computer/Box and before Harness construction',
    bindings, sharedBindings: library.promptToolsRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
