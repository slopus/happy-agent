import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentModuleHooks, AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { vi } from "vitest";

import { AccountLinkModule, type AccountLinkStatus } from "../../../sources/accountLink/index.js";
import type { BotsModule } from "../../../sources/bots/index.js";
import type { ConfigModule } from "../../../sources/config/index.js";
import type { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import type { NodeModule } from "../../../sources/node/index.js";

export const LOCAL_TOKEN = "local-owner-token";

export interface AccountLinkWorldOptions {
    readonly accountsUrl?: string;
    readonly relayUrl?: string;
    /** Reuse another world's files, as a restarted daemon would. */
    readonly root?: string;
    readonly socketPath?: string;
    readonly team?: boolean;
}

export interface AccountLinkWorld {
    readonly credentialsPath: string;
    readonly ctx: Context;
    readonly invoke: ReturnType<typeof vi.fn>;
    readonly module: AccountLinkModule;
    readonly root: string;
    close(): Promise<void>;
    tool(agentId: string, name: string): Promise<AnyAgentTool>;
    toolNames(agentId: string): Promise<readonly string[]>;
    /** Run a tool as the admin bot, the way the agent loop would. */
    run(name: string, input?: unknown): Promise<AccountLinkStatus>;
    waitFor(
        predicate: (status: AccountLinkStatus) => boolean,
        timeoutMs?: number,
    ): Promise<AccountLinkStatus>;
}

const roots: string[] = [];

export async function removeAccountLinkWorlds(): Promise<void> {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}

/** The module with its collaborators replaced by the few answers it asks them for. */
export async function createAccountLinkWorld(
    options: AccountLinkWorldOptions = {},
): Promise<AccountLinkWorld> {
    let root = options.root;
    if (root === undefined) {
        root = await mkdtemp(join(tmpdir(), "happy-account-link-"));
        roots.push(root);
        await writeFile(join(root, "token"), `${LOCAL_TOKEN}\n`, { mode: 0o600 });
    }
    const credentialsPath = join(root, "account-link", "credentials.json");
    const config = {
        accountLink:
            options.accountsUrl === undefined || options.relayUrl === undefined
                ? undefined
                : { accountsUrl: options.accountsUrl, relayUrl: options.relayUrl },
        accountLinkCredentialsPath: credentialsPath,
        configuration: {
            paths: {
                socketPath: options.socketPath ?? join(root, "agent.sock"),
                tokenPath: join(root, "token"),
            },
            values: { feature: { team: { enabled: options.team === true } } },
        },
    } as unknown as ConfigModule;
    const bots = {
        forAgent: async (_ctx: Context, agentId: string) => {
            if (agentId === "admin-agent") return { isAdmin: true, status: "active" };
            if (agentId === "ordinary-agent") return { isAdmin: false, status: "active" };
            if (agentId === "archived-admin-agent") return { isAdmin: true, status: "archived" };
            return undefined;
        },
    } as unknown as BotsModule;
    const node = { get: async () => ({ name: "Test Workstation" }) } as unknown as NodeModule;
    const invoke = vi.fn(async () => ({ callId: "account-link-call", status: "created" as const }));
    const durableFunctions = { invoke, register: vi.fn() } as unknown as DurableFunctionsModule;
    const module = new AccountLinkModule(config, bots, node, durableFunctions);
    const ctx = createRootContext().named("account-link-test");
    const hooks: AgentModuleHooks = await module.beforeStart(ctx);
    await hooks.afterStart?.(ctx, undefined as never);

    const toolsFor = async (agentId: string): Promise<readonly AnyAgentTool[]> => {
        const scope = { agent: { id: agentId } } as unknown as AgentModuleScope;
        return (await hooks.tools?.(ctx, scope)) ?? [];
    };
    const tool = async (agentId: string, name: string): Promise<AnyAgentTool> => {
        const found = (await toolsFor(agentId)).find((candidate) => candidate.name === name);
        if (found === undefined) throw new Error(`The ${name} tool is missing.`);
        return found;
    };
    return {
        close: async () => await module.close(ctx),
        credentialsPath,
        ctx,
        invoke,
        module,
        root,
        run: async (name, input = {}) =>
            (await (
                await tool("admin-agent", name)
            ).execute(ctx, input as never, toolCall(name))) as AccountLinkStatus,
        tool,
        toolNames: async (agentId) => (await toolsFor(agentId)).map((entry) => entry.name),
        waitFor: async (predicate, timeoutMs = 10_000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const status = module.currentStatus();
                if (predicate(status)) return status;
                if (Date.now() > deadline) {
                    throw new Error(`Timed out waiting; last status: ${JSON.stringify(status)}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
    };
}

function toolCall(id: string): never {
    return {
        id,
        kv: {
            getOrCreate: async (_ctx: Context, _key: string, create: () => unknown) =>
                await create(),
        },
        commit: async (_ctx: Context, result: unknown) => result,
    } as never;
}
