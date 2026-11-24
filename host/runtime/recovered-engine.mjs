import { constructRecoveredModules } from './recovered-modules.mjs';
import {
  createSendToUserVisibilityReminder,
  hasVisibilityReminderSinceLastWork,
  wrapActionHandler,
} from './turn-continuity.mjs';

export function constructRecoveredEngine(library, directory) {
  const original = library.getEngineRecoveryBindings();
  const bindings = {
    ...original,
    ...(typeof original.hasProjectSendMessageReminderForCurrentRequest === 'function'
      ? {
        hasProjectSendMessageReminderForCurrentRequest: messages =>
          hasVisibilityReminderSinceLastWork(messages, original.hasProjectSendMessageReminderForCurrentRequest),
      }
      : {}),
    ...(typeof original.createProjectSendMessageVisibilityReminder === 'function'
      ? {
        createProjectSendMessageVisibilityReminder: () =>
          createSendToUserVisibilityReminder(original.createProjectSendMessageVisibilityReminder),
      }
      : {}),
  };
  return constructRecoveredModules(library.engineRecoveryPlan, bindings, directory, 'Engine', {
    overrides: {
      AbstractUserMessageActionHandler: recovered => wrapActionHandler(recovered, {
        fromRedactedCoreMessages: original.fromRedactedCoreMessages,
        PrivacyCapability: original.PrivacyCapability,
      }),
    },
  });
}

export async function installRecoveredEngine(library, directory) {
  const constructed = await constructRecoveredEngine(library, directory);
  const bindings = library.installRecoveredEngine(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, before Harness construction',
    bindings, modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
