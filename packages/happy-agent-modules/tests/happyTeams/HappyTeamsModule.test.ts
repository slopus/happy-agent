import type { AgentModuleScope, AgentSystemRef, AnyAgentTool } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../../sources/bots/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { CloudModule } from "../../sources/cloud/index.js";
import { HappyTeamsModule } from "../../sources/happyTeams/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-teams-module-test");
const admin = {
    id: "admin-bot",
    isAdmin: true,
    name: "Chief of Staff",
    status: "active",
} as BotRecord;
const member = {
    id: "member-bot",
    isAdmin: false,
    name: "Researcher",
    status: "active",
} as BotRecord;
const archivedAdmin = {
    id: "archived-admin-bot",
    isAdmin: true,
    name: "Former Chief of Staff",
    status: "archived",
} as BotRecord;

function fixture() {
    const cloud = {
        createTeam: vi.fn(async (_ctx: Context, name: string, endpoint: string) => ({
            endpoint,
            id: "org_created",
            name,
        })),
        getWorkOSState: vi.fn(async () => ({
            workosClientId: "client_01HAPPYPRODUCTION",
            workosUserId: "user_01HAPPYOWNER",
        })),
        listTeams: vi.fn(async () => [
            { endpoint: "https://team.example/", id: "org_existing", name: "Existing Team" },
        ]),
        setTeamEndpoint: vi.fn(async (_ctx: Context, _id: string, endpoint: string) => endpoint),
    } as unknown as CloudModule;
    const bots = {
        forAgent: vi.fn(async (_ctx: Context, agentId: string) => {
            if (agentId === "admin-agent") return admin;
            if (agentId === "member-agent") return member;
            if (agentId === "archived-admin-agent") return archivedAdmin;
            return undefined;
        }),
        list: vi.fn(async () => [admin, member, archivedAdmin]),
    } as unknown as BotsModule;
    const agents = {
        parentOf: vi.fn(async (_ctx: Context, agentId: string) =>
            agentId === "subagent" ? "human-agent" : null,
        ),
    } as unknown as AgentSystemRef;
    return { agents, bots, cloud, module: new HappyTeamsModule(cloud, bots) };
}

async function toolsFor(
    module: HappyTeamsModule,
    agents: AgentSystemRef,
    agentId: string,
): Promise<readonly AnyAgentTool[]> {
    const hooks = await resolveModuleHooks(ctx, module, agents);
    return (
        (await hooks.tools?.(ctx, {
            agent: { id: agentId },
        } as unknown as AgentModuleScope)) ?? []
    );
}

function call() {
    return {
        id: "happy-team-call",
        kv: {},
        commit: async (_ctx: Context, value: unknown) => value,
    } as never;
}

describe("HappyTeamsModule", () => {
    it("gives the WorkOS state tool only to an active admin bot", async () => {
        const test = fixture();
        const humanTools = await toolsFor(test.module, test.agents, "human-agent");
        const adminTools = await toolsFor(test.module, test.agents, "admin-agent");
        const memberTools = await toolsFor(test.module, test.agents, "member-agent");
        const archivedAdminTools = await toolsFor(test.module, test.agents, "archived-admin-agent");
        const subagentTools = await toolsFor(test.module, test.agents, "subagent");

        const names = ["list_happy_teams", "create_happy_team", "update_happy_team"];
        expect(humanTools.map(({ name }) => name)).toEqual(names);
        expect(adminTools.map(({ name }) => name)).toEqual([...names, "get_happy_workos_state"]);
        expect(memberTools.map(({ name }) => name)).toEqual(names);
        expect(archivedAdminTools.map(({ name }) => name)).toEqual(names);
        expect(subagentTools).toEqual([]);
        expect(humanTools[0]).toMatchObject({ durable: true, reloadable: true });
        expect(humanTools[1]).toMatchObject({ durable: false });
        expect(humanTools[2]).toMatchObject({ durable: false });
        expect(adminTools[3]).toMatchObject({ durable: true, reloadable: true });
        for (const tool of adminTools) {
            expect(tool).toMatchObject({ requiresAutoOrFullAccess: true });
            expect(await tool.shouldReviewInAutoMode({}, ctx)).toBe(true);
        }
    });

    it("uses separate closed contracts for WorkOS state, list, create, and endpoint update", async () => {
        const test = fixture();
        const tools = await toolsFor(test.module, test.agents, "admin-agent");
        const list = tools.find(({ name }) => name === "list_happy_teams")!;
        const create = tools.find(({ name }) => name === "create_happy_team")!;
        const update = tools.find(({ name }) => name === "update_happy_team")!;
        const state = tools.find(({ name }) => name === "get_happy_workos_state")!;

        expect(Value.Check(list.parameters, {})).toBe(true);
        expect(Value.Check(list.parameters, { offset: 10 })).toBe(true);
        expect(
            Value.Check(create.parameters, {
                endpoint: "tailcat://tcAnalytical:32123",
                name: "Analytical Engines",
            }),
        ).toBe(true);
        expect(Value.Check(create.parameters, { name: "Analytical Engines" })).toBe(false);
        expect(
            Value.Check(update.parameters, {
                endpoint: "https://team.example/agent",
                team_id: "org_existing",
            }),
        ).toBe(true);
        expect(Value.Check(list.parameters, { endpoint: "https://unexpected.example" })).toBe(
            false,
        );
        expect(Value.Check(state.parameters, {})).toBe(true);
        expect(Value.Check(state.parameters, { unexpected: true })).toBe(false);
        expect(
            Value.Check(state.returnType, {
                workos_client_id: "client_01HAPPYPRODUCTION",
                workos_user_id: "user_01HAPPYOWNER",
            }),
        ).toBe(true);
        expect(
            Value.Check(state.returnType, {
                workos_client_id: "user_wrong",
                workos_user_id: "org_wrong",
            }),
        ).toBe(false);

        vi.mocked(test.cloud.listTeams).mockResolvedValue(
            Array.from({ length: 11 }, (_value, index) => ({
                endpoint: "https://team.example/",
                id: `org_${String(index)}`,
                name: `Team ${String(index)}`,
            })),
        );
        const firstPage = await list.execute(ctx, {}, call());
        expect(firstPage).toMatchObject({ next_offset: 10 });
        expect((firstPage as { teams: readonly unknown[] }).teams).toHaveLength(10);
        await expect(list.execute(ctx, { offset: 10 }, call())).resolves.toEqual({
            next_offset: null,
            teams: [{ endpoint: "https://team.example/", id: "org_10", name: "Team 10" }],
        });
        await expect(
            create.execute(
                ctx,
                {
                    endpoint: "tailcat://tcAnalytical:32123",
                    name: "Analytical Engines",
                },
                call(),
            ),
        ).resolves.toEqual({
            endpoint: "tailcat://tcAnalytical:32123",
            id: "org_created",
            name: "Analytical Engines",
        });
        await expect(
            update.execute(
                ctx,
                {
                    endpoint: "https://team.example/agent",
                    team_id: "org_existing",
                },
                call(),
            ),
        ).resolves.toEqual({
            endpoint: "https://team.example/agent",
            team_id: "org_existing",
        });
        await expect(state.execute(ctx, {}, call())).resolves.toEqual({
            workos_client_id: "client_01HAPPYPRODUCTION",
            workos_user_id: "user_01HAPPYOWNER",
        });
        expect(test.cloud.getWorkOSState).toHaveBeenCalledOnce();
    });

    it("refuses every operation from a non-admin bot and names the admin", async () => {
        const test = fixture();
        const tools = await toolsFor(test.module, test.agents, "member-agent");
        const list = tools.find(({ name }) => name === "list_happy_teams")!;
        const create = tools.find(({ name }) => name === "create_happy_team")!;
        const update = tools.find(({ name }) => name === "update_happy_team")!;
        expect(tools.some(({ name }) => name === "get_happy_workos_state")).toBe(false);

        await expect(list.execute(ctx, {}, call())).rejects.toThrow("Chief of Staff");
        await expect(
            create.execute(
                ctx,
                { endpoint: "tailcat://tcBlocked:32123", name: "Blocked Team" },
                call(),
            ),
        ).rejects.toThrow("Chief of Staff");
        await expect(
            update.execute(
                ctx,
                { endpoint: "https://blocked.example/", team_id: "org_blocked" },
                call(),
            ),
        ).rejects.toThrow("Chief of Staff");
        expect(test.cloud.listTeams).not.toHaveBeenCalled();
        expect(test.cloud.createTeam).not.toHaveBeenCalled();
        expect(test.cloud.setTeamEndpoint).not.toHaveBeenCalled();
        await expect(test.module.getWorkOSState(ctx, "member-agent")).rejects.toThrow(
            "Only an active admin bot",
        );
        expect(test.cloud.getWorkOSState).not.toHaveBeenCalled();
    });
});
