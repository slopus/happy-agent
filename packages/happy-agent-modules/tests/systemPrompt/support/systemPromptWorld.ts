import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { ComputeModule, type HostCompute } from "../../../sources/compute/index.js";
import { ConfigModule } from "../../../sources/config/index.js";
import { SecretsModule } from "../../../sources/secrets/index.js";
import { SystemPromptModule } from "../../../sources/systemPrompt/index.js";

/** A catalog entry shaped the way an account reports one. */
export function catalogModel(name: string, id: string, providerId: string): AgentModel {
    return {
        providerId,
        id,
        name,
        effortLevels: ["off", "medium", "high"],
        defaultEffort: "medium",
    } as AgentModel;
}

export interface SystemPromptWorldOptions {
    /** The catalog configuration serves. Omitted leaves this installation's own catalog. */
    readonly models?: readonly AgentModel[];
    /** The person's own instructions, written where configuration says they live. */
    readonly globalInstructions?: string;
    /** The machine an agent runs on, looked up the way the compute module looks one up. */
    readonly compute?: (ctx: Context, agentId: string) => Promise<HostCompute | undefined>;
}

export interface SystemPromptWorld {
    readonly config: ConfigModule;
    readonly module: SystemPromptModule;
    /** Rewrite the person's own instructions, as editing that file would. */
    writeGlobalInstructions(text: string): Promise<void>;
    /** Remove the person's own instructions, as deleting that file would. */
    removeGlobalInstructions(): Promise<void>;
}

/**
 * A system-prompt module reading a configuration of its own.
 *
 * The module takes its catalog and the person's global instructions from configuration, so a test
 * that wants either one puts it where configuration looks: the catalog through the product's own
 * inference override, the instructions in a real file under a Happy root nobody else shares.
 */
export async function systemPromptWorld(
    options: SystemPromptWorldOptions = {},
): Promise<SystemPromptWorld> {
    const root = await mkdtemp(join(tmpdir(), "happy-system-prompt-"));
    const config = await ConfigModule.load(
        join(root, ".happy"),
        options.models === undefined
            ? {}
            : { inference: { models: options.models, providers: new AgentProviders() } },
    );
    const instructionsPath = config.configuration.paths.instructionsPath;
    const writeGlobalInstructions = async (text: string): Promise<void> => {
        await mkdir(dirname(instructionsPath), { recursive: true });
        await writeFile(instructionsPath, text, "utf8");
    };
    if (options.globalInstructions !== undefined) {
        await writeGlobalInstructions(options.globalInstructions);
    }
    const resolve = options.compute ?? (async (): Promise<undefined> => undefined);
    const module = new SystemPromptModule(config, new WorldComputeModule(config, resolve));
    return {
        config,
        module,
        writeGlobalInstructions,
        removeGlobalInstructions: async (): Promise<void> => {
            await rm(instructionsPath, { force: true });
        },
    };
}

/**
 * A compute module that hands out the machine the test built.
 *
 * Only the lookup is scripted: permissions, path resolution, and review decisions stay the
 * product's own, and they read the same configuration the module under test reads.
 */
class WorldComputeModule extends ComputeModule {
    readonly #resolve: (ctx: Context, agentId: string) => Promise<HostCompute | undefined>;

    constructor(
        config: ConfigModule,
        resolve: (ctx: Context, agentId: string) => Promise<HostCompute | undefined>,
    ) {
        super(config, new SecretsModule());
        this.#resolve = resolve;
    }

    override async resolve(ctx: Context, agentId: string): Promise<HostCompute | undefined> {
        return await this.#resolve(ctx, agentId);
    }
}
