import {
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import type { BotsModule } from "../../sources/bots/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { ProfileModule, type ProfileChangedEvent } from "../../sources/profile/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];
afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

async function fixture(bootstrap?: { name: string; email: string }, team = false) {
    const values = { profile: bootstrap, feature: { team: { enabled: team } } };
    let active = true;
    const config = { configuration: { values } } as unknown as ConfigModule;
    const bots = {
        forAgent: async (_ctx: unknown, id: string) =>
            id === "human"
                ? undefined
                : {
                      isAdmin: id !== "member",
                      status: active && id !== "archived" ? "active" : "archived",
                  },
    } as unknown as BotsModule;
    const module = new ProfileModule(config, bots);
    const database = moduleDatabase(module.migrations, "profile-bootstrap");
    ensureAgentDatabaseConnection(database.database);
    databases.push(database);
    await database.ready;
    const agents = {
        parentOf: async (_ctx: unknown, id: string) => (id === "child" ? "admin" : null),
    } as unknown as AgentSystemRef;
    const hooks = module.beforeStart(database.context, agents);
    const events: ProfileChangedEvent[] = [];
    module.onEvent((_ctx, event) => {
        events.push(event);
    });
    return {
        module,
        database,
        values,
        events,
        restart: () => new ProfileModule(config, bots),
        revoke: () => {
            active = false;
        },
        tools: async (id: string) =>
            await hooks.tools!(database.context, {
                agent: { id },
            } as AgentModuleScope),
    };
}

const copied = { name: "Ada Lovelace", email: "ada@example.test" };

describe("standalone profile bootstrap", () => {
    it("initializes from config without HTTP and preserves later edits across restart", async () => {
        const f = await fixture(copied);
        const ctx = f.database.context;
        await f.module.open(ctx, "remote-instance");
        const initial = (await f.module.get(ctx))!;
        expect(initial).toMatchObject({
            ...copied,
            parentInstanceId: "remote-instance",
            photo: null,
        });
        expect(f.events).toHaveLength(1);
        const edited = await f.module.update(ctx, initial.id, { name: "Remote Ada" });
        f.values.profile = { name: "Changed source", email: "other@example.test" };
        const restarted = f.restart();
        await restarted.open(ctx, "remote-instance");
        expect(await restarted.get(ctx)).toEqual(edited);
    });

    it("fills only missing fields and leaves an unconfigured installation lazy", async () => {
        const f = await fixture();
        const ctx = f.database.context;
        await f.module.open(ctx, "remote-instance");
        expect(await f.module.get(ctx)).toBeUndefined();
        const empty = await f.module.ensure(ctx);
        await f.module.update(ctx, empty.id, { name: "Existing name" });
        f.values.profile = copied;
        await f.restart().open(ctx, "remote-instance");
        expect(await f.module.get(ctx)).toMatchObject({
            id: empty.id,
            name: "Existing name",
            email: copied.email,
        });
    });

    it("participates in caller transactions and publishes only after commit", async () => {
        const f = await fixture(copied);
        const ctx = f.database.context;
        await expect(
            ctx.inTx(async (txCtx) => {
                await f.module.open(txCtx, "remote-instance");
                expect(await f.module.get(txCtx)).toMatchObject(copied);
                expect(f.events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await f.module.get(ctx)).toBeUndefined();
        expect(f.events).toEqual([]);
        await ctx.inTx(async (txCtx) => {
            await f.module.open(txCtx, "remote-instance");
            expect(f.events).toEqual([]);
        });
        expect(f.events).toHaveLength(1);
        expect(await f.module.get(ctx)).toMatchObject(copied);
    });
});

describe("get_local_profile tool", () => {
    it("is discoverable only by active root admin bots and rechecks at execution", async () => {
        const f = await fixture(copied);
        const ctx = f.database.context;
        await f.module.open(ctx, "remote-instance");
        for (const id of ["human", "member", "archived", "child"])
            expect(await f.tools(id)).toEqual([]);
        const tools = await f.tools("admin");
        expect(tools.map((tool) => tool.name)).toEqual(["get_local_profile"]);
        const tool = tools[0]!;
        expect(Value.Check(tool.parameters, {})).toBe(true);
        expect(Value.Check(tool.parameters, { agentId: "admin" })).toBe(false);
        expect(await tool.shouldReviewInAutoMode({}, ctx)).toBe(false);
        const result = await tool.execute(ctx, {}, {} as never);
        expect(result).toEqual(copied);
        expect(Value.Check(tool.returnType, result)).toBe(true);
        f.revoke();
        expect(await f.tools("admin")).toEqual([]);
        await expect(tool.execute(ctx, {}, {} as never)).rejects.toThrow(
            "Only an active admin bot",
        );
    });

    it("returns explicit missing values without creating a profile", async () => {
        const f = await fixture();
        const ctx = f.database.context;
        await f.module.open(ctx, "remote-instance");
        const [tool] = await f.tools("admin");
        expect(await tool!.execute(ctx, {}, {} as never)).toEqual({ name: null, email: null });
        expect(await f.module.get(ctx)).toBeUndefined();
    });

    it("does not expose or bootstrap a shared profile in team mode", async () => {
        const f = await fixture(copied, true);
        const ctx = f.database.context;
        await f.module.open(ctx, "remote-instance");
        expect(await f.tools("admin")).toEqual([]);
        expect(await f.module.get(ctx)).toBeUndefined();
        await expect(f.module.getLocalProfileForAdmin(ctx, "admin")).rejects.toThrow(
            "Only an active admin bot",
        );
    });
});
