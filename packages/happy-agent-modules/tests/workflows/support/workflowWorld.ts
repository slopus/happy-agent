import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ensureAgentDatabaseConnection,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { CollaborationModule } from "../../../sources/collaboration/CollaborationModule.js";
import { ConfigModule } from "../../../sources/config/index.js";
import { WorkflowsModule } from "../../../sources/workflows/index.js";
import { scriptedComputeModule, testConfig } from "../../support/computeModule.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";

/** The agent whose workflows every test in this suite runs. */
export const WORKFLOW_OWNER = "owner";

/** The model a test script asks its agents to run on; nothing here ever reaches a provider. */
export const WORKFLOW_MODEL = "test-model";

/** What one `agent()` call asked the collaboration module for. */
export interface StartedCollaborator {
    readonly actingAgentId: string;
    readonly agentId: string;
    readonly input: {
        readonly title: string;
        readonly model: string;
        readonly effort: string;
        readonly provider?: string;
        readonly serviceTier?: "priority";
        readonly text: string;
    };
    readonly options: {
        readonly reportToCreator?: boolean;
        readonly metadata?: Record<string, unknown>;
    };
}

/**
 * A stand-in for the collaboration module. It records what each agent call asked for and lets a
 * test wait for the calls a running script has reached, which is the only way to answer them in
 * the order the script expects.
 */
export class Collaborators {
    readonly started: StartedCollaborator[] = [];
    /** Who was told to stop, in the order they were told. */
    readonly interrupted: string[] = [];

    readonly #waiting: (() => void)[] = [];

    async createAgent(
        _ctx: Context,
        actingAgentId: string,
        input: StartedCollaborator["input"],
        agentId: string,
        options: StartedCollaborator["options"] = {},
    ): Promise<{ readonly agentId: string }> {
        this.started.push({ actingAgentId, agentId, input, options });
        for (const wake of this.#waiting.splice(0)) wake();
        return { agentId };
    }

    async interruptAgent(_ctx: Context, _actingAgentId: string, targetAgentId: string) {
        this.interrupted.push(targetAgentId);
    }

    /** Wait until the script has asked for this many agents. */
    async waitFor(count: number): Promise<readonly StartedCollaborator[]> {
        while (this.started.length < count) {
            await new Promise<void>((resolve) => {
                this.#waiting.push(resolve);
            });
        }
        return this.started;
    }

    /** One started agent, found by the label its script gave it. */
    async byTitle(title: string): Promise<StartedCollaborator> {
        for (;;) {
            const found = this.started.find((collaborator) => collaborator.input.title === title);
            if (found !== undefined) return found;
            await this.waitFor(this.started.length + 1);
        }
    }

    /** The module holds a `CollaborationModule`; this stub supplies only what it actually calls. */
    asModule(): CollaborationModule {
        return this as unknown as CollaborationModule;
    }
}

/** Everything a test drives one module with, over one database. */
export interface WorkflowWorld {
    readonly module: WorkflowsModule;
    readonly hooks: AgentModuleHooks;
    readonly ctx: Context;
    readonly collaborators: Collaborators;
    /** The tools this module offers the agent that owns the runs. */
    tools(): Promise<readonly AnyAgentTool[]>;
    /** Say what a collaborator finally said, exactly as Agent Base settles it. */
    answer(collaborator: StartedCollaborator, text: string): Promise<void>;
    /** Stop a collaborator without an answer, the way a failed session ends. */
    fail(collaborator: StartedCollaborator, message: string): Promise<void>;
    /** A second module over the same database, which is what a restarted process brings up. */
    restart(): Promise<WorkflowWorld>;
    close(): void;
}

interface WorkflowWorldOptions {
    /** Whether the configuration this module reads turns workflows on. Defaults to on. */
    readonly enabled?: boolean;
}

/**
 * Configuration with workflows turned off, written the way an installation turns them off.
 *
 * The module has no switch of its own any more, so a test that wants the feature dark has to say
 * so where the product says it: in `happy.toml`.
 */
async function configWithWorkflows(enabled: boolean): Promise<ConfigModule> {
    if (enabled) return testConfig;
    const root = await mkdtemp(join(tmpdir(), "happy-workflows-"));
    const configHome = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, "happy.toml"), "[features]\nworkflows = false\n", "utf8");
    return await ConfigModule.load(join(root, ".happy"));
}

/** One module, its database, and the collaboration it starts agents through. */
export async function workflowWorld(
    name: string,
    options: WorkflowWorldOptions = {},
): Promise<WorkflowWorld> {
    const database = moduleDatabase([], name);
    // Production hands every agent database this scheduling boundary. Without it the concurrent
    // transactions a fanned-out script opens would collide on the one in-memory connection.
    ensureAgentDatabaseConnection(database.database);
    const config = await configWithWorkflows(options.enabled ?? true);
    return await buildWorld(database, config);
}

async function buildWorld(
    database: ReturnType<typeof moduleDatabase>,
    config: ConfigModule,
): Promise<WorkflowWorld> {
    const collaborators = new Collaborators();
    const module = new WorkflowsModule(
        config,
        collaborators.asModule(),
        // No test here reaches a machine: a script named by path has nowhere to be read from.
        scriptedComputeModule(async () => undefined),
    );
    // A run executes on the database's own context, so the module cannot be built before the
    // database is: its migrations are applied here rather than through `moduleDatabase`.
    for (const [, migrate] of module.migrations) {
        await migrate(database.context, database.database);
    }
    const hooks = await resolveModuleHooks(database.context, module);
    const scopes = new Map<string, AgentModuleScope>();
    const scopeOf = (collaborator: StartedCollaborator): AgentModuleScope => {
        const existing = scopes.get(collaborator.agentId);
        if (existing !== undefined) return existing;
        const created = collaboratorScope(collaborator);
        scopes.set(collaborator.agentId, created);
        return created;
    };
    return {
        module,
        hooks,
        ctx: database.context,
        collaborators,
        tools: async () =>
            (await hooks.tools?.(database.context, ownerScope())) ?? ([] as AnyAgentTool[]),
        answer: async (collaborator, text) => {
            const scope = scopeOf(collaborator);
            await hooks.onEventTransact?.(database.context, scope, textEnd(text));
            await hooks.afterAgentSettledTransact?.(
                database.context,
                scope,
                settlement(collaborator.agentId),
            );
        },
        fail: async (collaborator, message) => {
            const scope = scopeOf(collaborator);
            await hooks.onEvent?.(database.context, scope, errorDone(message));
            await hooks.afterAgentSettledTransact?.(
                database.context,
                scope,
                settlement(collaborator.agentId),
            );
        },
        restart: async () => await buildWorld(database, config),
        close: database.close,
    };
}

/**
 * The scope Agent Base hands a module's hooks for one workflow collaborator: the collaborator's
 * own identity and metadata, and the run store its answer is kept in until it settles.
 */
function collaboratorScope(collaborator: StartedCollaborator): AgentModuleScope {
    const values = new Map<string, unknown>();
    return {
        agent: { id: collaborator.agentId, metadata: collaborator.options.metadata },
        runKV: {
            read: async (_ctx: Context, key: string) => values.get(key),
            write: async (_ctx: Context, key: string, value: unknown) => {
                values.set(key, value);
            },
        },
    } as never;
}

/** The scope of the agent that owns the workflows, which is what the tools are built for. */
function ownerScope(): AgentModuleScope {
    return { agent: { id: WORKFLOW_OWNER } } as never;
}

function textEnd(text: string) {
    return { type: "text_end", block: { type: "text", text } } as never;
}

function errorDone(message: string) {
    return { type: "done", state: "error", kind: "internal_error", message } as never;
}

function settlement(settlementId: string) {
    return { loopId: "loop", settlementId } as never;
}

/** One agent request, in the dictionary form a workflow script writes it. */
export function agentRequest(label: string, prompt: string): string {
    return `{"prompt": ${JSON.stringify(prompt)}, "label": ${JSON.stringify(label)}, "model": ${JSON.stringify(WORKFLOW_MODEL)}, "effort": "medium"}`;
}

/** The options half of the same request, for a direct `agent(...)` call. */
export function agentOptions(label: string): string {
    return `{"label": ${JSON.stringify(label)}, "model": ${JSON.stringify(WORKFLOW_MODEL)}, "effort": "medium"}`;
}
