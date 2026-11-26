import { constructRecoveredModules } from './recovered-modules.mjs';
import { installRemoteBoxAdapter } from './remote-box.mjs';
import { createComputerParkOverrides, readDesktopParkConfig } from './idle-desktop-park.mjs';

export async function installRecoveredComputer(library, directory, env = process.env) {
  const original = library.getComputerRecoveryBindings();
  const parkEnabled = readDesktopParkConfig(env).enabled;
  const overrides = parkEnabled
    ? createComputerParkOverrides(original, message => console.warn(message))
    : undefined;
  const constructed = await constructRecoveredModules(library.computerRecoveryPlan,
    original, directory, 'Computer/Box', overrides ? { overrides } : {});
  const deployment = installRemoteBoxAdapter(constructed.bindings, original);
  const bindings = library.installRecoveredComputer(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, before Harness and Host construction',
    bindings, sharedBindings: library.computerRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount, deployment };
}
