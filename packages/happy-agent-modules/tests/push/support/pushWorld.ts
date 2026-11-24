import { inspect } from "node:util";

import { ensureAgentDatabaseConnection, type AgentSystemRef } from "@slopus/happy-agent-base";
import { withLogger, type Context } from "@steve.kite/stdlib";
import { vi } from "vitest";

import type { ConfigModule } from "../../../sources/config/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import { PushModule, type PushNotification } from "../../../sources/push/index.js";
import type { SubtasksModule } from "../../../sources/subtasks/index.js";
import type { TasksModule } from "../../../sources/tasks/index.js";
import { TeamModule, withTeamUser, type TeamUser } from "../../../sources/team/index.js";
import {
    pendingCallCount,
    waitForCondition,
} from "../../durableFunctions/support/durableFunctionsHarness.js";
import { moduleDatabase, type ModuleDatabase } from "../../support/moduleDatabase.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";
import { testProfileModule } from "../../support/testProfileModule.js";

export const NOW = 1_700_000_000_000;
export const THIRTY_DAYS = 2_592_000_000;
export const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
export const ALICE = "alice0000000000000000001";
export const BOB = "bob000000000000000000002";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RELAY = "https://push.cluster-fluster.com/v1/push/send";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const token = (n: number) => `HappyPushToken[phone${String(n).padStart(17, "0")}]`;
export const phone = (n: number) => ({
    token: token(n),
    platform: "ios",
    appId: "com.ex3ndr.happy",
});
export const notice: PushNotification = {
    notificationId: "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f",
    title: "iOS preview 24 uploaded; prod is blocked",
    body: "Prod needs build number 164 committed on main first",
    agentId: "pfh0haxfpzowht3oi213cqos",
};

export interface RelayRequest {
    readonly url: string;
    readonly method: string | undefined;
    readonly contentType: string | null;
    readonly redirect: string | undefined;
    readonly body: {
        readonly to?: unknown;
        readonly data?: Record<string, unknown>;
        readonly [field: string]: unknown;
    };
}

/** Stand in for Happy's relay: record every request and answer it, accepted unless told otherwise. */
export function stubRelay(
    answer: (
        body: Record<string, unknown>,
        signal: AbortSignal | null | undefined,
    ) => Response | Promise<Response> = () =>
        Response.json({ data: [{ status: "ok", id: "ticket-1" }] }),
): RelayRequest[] {
    const requests: RelayRequest[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({
            url: String(input),
            method: init.method,
            contentType: new Headers(init.headers).get("content-type"),
            redirect: init.redirect,
            body,
        });
        return await answer(body, init.signal);
    });
    return requests;
}

/** Whose agents these are: nobody's task, no subtasks, and no parents unless a test says so. */
export interface PushWorldAgents {
    /** Each agent's parent; an agent not listed is a root. */
    readonly parents?: Readonly<Record<string, string>>;
    /** The agents that are user-visible subtasks. */
    readonly subtasks?: readonly string[];
    /** The team user who owns the task whose agent this is. */
    readonly taskOwners?: Readonly<Record<string, string>>;
}

function pushModule(team: boolean, durable: DurableFunctionsModule, agents: PushWorldAgents = {}) {
    const tasks = {
        forAgent: (_ctx: Context, agentId: string) =>
            Promise.resolve(
                agents.taskOwners?.[agentId] === undefined
                    ? undefined
                    : { ownerUserId: agents.taskOwners[agentId] },
            ),
    } as unknown as TasksModule;
    const subtasks = {
        isSubtask: (agent: { readonly id?: string } | undefined) =>
            agent?.id !== undefined && (agents.subtasks ?? []).includes(agent.id),
    } as unknown as SubtasksModule;
    return new PushModule(createTeam(team), config, durable, tasks, subtasks);
}

export function pushDatabase(name: string): ModuleDatabase {
    const durable = new DurableFunctionsModule();
    const push = pushModule(false, durable);
    const database = moduleDatabase([...durable.migrations, ...push.migrations], name);
    ensureAgentDatabaseConnection(database.database);
    return database;
}

/** A push module on a started Durable Functions module, as the daemon runs them. */
export async function startWorld(
    name: string,
    options: {
        readonly team: boolean;
        readonly database?: ModuleDatabase;
        readonly agents?: PushWorldAgents;
    },
) {
    const durable = new DurableFunctionsModule();
    const push = pushModule(options.team, durable, options.agents);
    const database = options.database ?? pushDatabase(name);
    await database.ready;
    const logs: string[] = [];
    const record = (_context: unknown, ...args: unknown[]) => {
        logs.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" "));
    };
    const ctx = withLogger(database.context, {
        trace: record,
        debug: record,
        info: record,
        warn: record,
        error: record,
        fatal: record,
    });
    const agents = {
        parentOf: (_ctx: Context, agentId: string) =>
            Promise.resolve(options.agents?.parents?.[agentId] ?? null),
    } as unknown as AgentSystemRef;
    const durableHooks = await resolveModuleHooks(ctx, durable, agents);
    const hooks = await resolveModuleHooks(ctx, push, agents);
    await durableHooks.afterStart?.(ctx, agents);
    const settle = async () => {
        await waitForCondition(async () => (await pendingCallCount(ctx)) === 0);
    };
    return {
        push,
        /** The push module's agent hooks, as the agent loop calls them. */
        hooks,
        ctx,
        logs,
        settle,
        /** Notify one person and wait until every phone has been tried. */
        send: async (recipient: string, notification: PushNotification) => {
            await push.send(ctx, recipient, notification);
            await settle();
        },
        stop: () => durable.stop(),
        close: () => {
            durable.stop();
            database.close();
        },
    };
}

const config = { instanceId: async () => INSTANCE } as unknown as ConfigModule;

export function member(ctx: Context, userId: string): Context {
    return withTeamUser(ctx, {
        id: userId,
        authentication: "workos",
        subject: `user_${userId}`,
        firstName: "Test",
        lastName: null,
        email: `${userId}@example.com`,
        isOwner: false,
        photo: null,
        createdAt: 0,
        updatedAt: 0,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    } as TeamUser);
}

function createTeam(enabled: boolean): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            authentication: "workos",
                            enabled,
                            host: "127.0.0.1",
                            ownerWorkOSUserId: "user_01TESTUSER123",
                            port: 3_000,
                            workosClientId: "client_test123",
                            workosOrganizationId: "org_01TESTORG123",
                        },
                    },
                },
            },
        } as never,
        testProfileModule(),
    );
}
