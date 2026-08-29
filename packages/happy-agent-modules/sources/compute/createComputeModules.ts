import { SkillsModule } from "../skills/SkillsModule.js";
import { ComputeModule } from "./ComputeModule.js";

export interface CreatedComputeModules {
    readonly computeModule: ComputeModule;
    readonly skillsModule: SkillsModule;
    readonly modules: readonly [ComputeModule, SkillsModule];
}

/**
 * The module set a machine brings with it.
 *
 * Skills are discovered on the agent's own machine, so a compute module always arrives with the
 * skills module reading through it. The compute module is built by its caller — ordinarily
 * `new ComputeModule(config, secrets)`, or `ComputeModule.withProvider(...)` where the machine is
 * swapped — and this puts the pair in the order an agent collection wants them.
 */
export function createComputeModules(computeModule: ComputeModule): CreatedComputeModules {
    const skillsModule = new SkillsModule(computeModule);
    return {
        computeModule,
        skillsModule,
        modules: [computeModule, skillsModule],
    };
}
