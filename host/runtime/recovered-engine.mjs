import { constructRecoveredModules } from './recovered-modules.mjs';
import {
  createSendToUserVisibilityReminder,
  hasVisibilityReminderSinceLastWork,
  wrapActionHandler,
} from './turn-continuity.mjs';

export function constructRecoveredEngine(library, directory) {
  const original = library.getEngineRecoveryBindings();
  if (typeof original.hasProjectSendMessageReminderForCurrentRequest !== 'function') {
    throw new TypeError('Missing Engine dependency: hasProjectSendMessageReminderForCurrentRequest');
  }
  if (typeof original.createProjectSendMessageVisibilityReminder !== 'function') {
    throw new TypeError('Missing Engine dependency: createProjectSendMessageVisibilityReminder');
  }
  if (typeof original.fromRedactedCoreMessages !== 'function') {
    throw new TypeError('Missing Engine dependency: fromRedactedCoreMessages');
  }
  if (original.PrivacyCapability?.UNSAFE_ALWAYS_ALLOWED === undefined) {
    throw new TypeError('Missing Engine dependency: PrivacyCapability.UNSAFE_ALWAYS_ALLOWED');
  }
  const bindings = {
    ...original,
    hasProjectSendMessageReminderForCurrentRequest: messages => hasVisibilityReminderSinceLastWork(messages),
    createProjectSendMessageVisibilityReminder: () =>
      createSendToUserVisibilityReminder(original.createProjectSendMessageVisibilityReminder),
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
