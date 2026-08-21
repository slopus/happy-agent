import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentModel, AgentStorage } from "@slopus/happy-agent-base";
import { ComputeModule, type HostComputeProvider } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { SystemPromptModule } from "../../sources/systemPrompt/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { agentWorld } from "./agentWorld.js";
import { providersOf } from "./fixtures.js";
import { ScriptedProvider, type ScriptedTurn } from "./ScriptedProvider.js";

/**
 * The one account and model an automatic review runs on in these tests.
 *
 * `AutoModule` takes both from the configuration now, so a test scripts them by loading a
 * configuration whose inference is overridden rather than by handing the module a catalog.
 */
export const AUTO_TEST_MODELS: readonly AgentModel[] = [
    {
        providerId: "scripted",
        id: "scripted/model",
        name: "Scripted",
        effortLevels: ["low"],
        defaultEffort: "low",
    },
];

/** The modules `AutoModule` is composed from, over one installation of its own. */
export interface AutoWorld {
    readonly config: ConfigModule;
    readonly compute: ComputeModule;
    readonly systemPrompt: SystemPromptModule;
    /** The private review system's storage — the one structural argument `SPEC.md` §13.3 keeps. */
    readonly storage: AgentStorage;
    readonly provider: ScriptedProvider;
    /** The machine every agent in this world, reviewer included, works on. */
    readonly machine: FakeCompute;
    /** Where the reviewed agents work: the folder both security documents are read from. */
    readonly publicHome: string;
    /** Write the person's own `SECURITY.md`, as configuration says where it lives. */
    writeGlobalSecurity(text: string): Promise<void>;
    /** Write the working folder's `AGENTS_SECURITY.md`. */
    writeProjectSecurity(text: string): Promise<void>;
}

/**
 * One installation of its own: a Happy root nothing else shares, a scripted account, and a machine
 * made of maps.
 *
 * Everything `AutoModule` needs now comes from a real sibling module, so a test that wants a
 * security policy writes the file configuration reads, and a test that wants project instructions
 * writes the `AGENTS.md` the system-prompt module reads off the machine.
 */
export async function autoWorld(script: ScriptedTurn[] = []): Promise<AutoWorld> {
    // A root of its own rather than a temporary directory directly: the working folder is derived
    // as a sibling of the Happy home, so a home made straight in `tmpdir()` would put every test's
    // working folder at the same shared path.
    const root = await mkdtemp(join(tmpdir(), "happy-auto-"));
    const happyHome = join(root, ".happy");
    const provider = new ScriptedProvider(script);
    const config = await ConfigModule.load(happyHome, {
        inference: { models: AUTO_TEST_MODELS, providers: providersOf(provider) },
    });
    const publicHome = config.configuration.paths.publicHome;
    await mkdir(publicHome, { recursive: true });
    const machine = new FakeCompute(publicHome);
    const hostProvider: HostComputeProvider = { id: "host", create: async () => machine };
    const compute = ComputeModule.withProvider(config, hostProvider);
    const store = await agentWorld();
    return {
        config,
        compute,
        systemPrompt: new SystemPromptModule(config, compute),
        storage: store.storage,
        provider,
        machine,
        publicHome,
        writeGlobalSecurity: async (text: string): Promise<void> => {
            const path = config.configuration.paths.securityPath;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, text, "utf8");
        },
        writeProjectSecurity: async (text: string): Promise<void> => {
            await writeFile(join(publicHome, "AGENTS_SECURITY.md"), text, "utf8");
        },
    };
}
