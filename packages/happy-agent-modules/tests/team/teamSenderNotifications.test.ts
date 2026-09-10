import {
    AgentKV,
    AgentStorage,
    type AgentModuleScope,
    type AgentBaseSystemNotificationBoundary,
} from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it } from "vitest";

import { TeamModule, withTeamIdentity } from "../../sources/team/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const close of cleanup.splice(0)) close();
});

function createTeam(enabled = true) {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            enabled,
                            workosClientId: "client_test123",
                            workosOrganizationId: "org_test123",
                            ownerWorkOSUserId: "user_alice123",
                        },
                    },
                },
            },
        } as never,
        testProfileModule(),
    );
}

const inference: AgentBaseSystemNotificationBoundary = {
    type: "inference",
    inference: {
        loopId: "loop",
        turnId: "turn",
        inferenceId: "inference",
        contextTokens: undefined,
    },
};

function message(
    userId?: string | number,
    origin: "user" | "agent" = "user",
): AgentBaseSystemNotificationBoundary {
    return {
        type: "message",
        accepted: {
            id: "message123",
            kind: "send",
            profile: null,
            message: { role: "user", content: [{ type: "text", text: "unchanged" }] },
            metadata: {
                ...(origin === undefined ? {} : { messageOrigin: origin }),
                ...(userId === undefined ? {} : { userId }),
            },
        },
    };
}

async function setup(enabled = true) {
    const team = createTeam(enabled);
    const database = moduleDatabase(team.migrations, "team-sender-notifications");
    cleanup.push(database.close);
    await database.ready;
    const storage = new AgentStorage({
        database: database.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    await storage.migrate(database.context, []);
    const hooks = await resolveModuleHooks(database.context, team);
    const scope = (id = "agent123"): AgentModuleScope => {
        const persistence = storage.persistence(id);
        return {
            agent: {
                id,
                provider: "scripted",
                providerKind: "gym",
                model: undefined,
                effort: undefined,
                tier: undefined,
                permissionMode: "full_access",
                metadata: undefined,
            },
            kv: new AgentKV(persistence, "team.agent."),
            historyKV: new AgentKV(persistence, "team.history."),
            runKV: new AgentKV(persistence, "team.run."),
            sharedKV: storage.kv.scoped("team"),
        };
    };
    const primary = scope();
    const invoke = async (boundary: AgentBaseSystemNotificationBoundary, target = primary) =>
        await storage.transaction(
            database.context,
            async (ctx) => await hooks.systemNotificationsTransact?.(ctx, target, boundary),
        );
    const alice = await team.createUser(database.context, {
        firstName: "Alice",
        lastName: "Example",
        email: "alice@example.test",
        workosUserId: "user_alice123",
    });
    const bob = await team.createUser(database.context, {
        firstName: "Bob",
        workosUserId: "user_bob123",
    });
    return { team, database, storage, hooks, scope, primary, invoke, alice, bob };
}

describe("Team sender profile notifications", () => {
    it("includes display profile data without repeating unchanged senders or leaking private fields", async () => {
        const { invoke, alice, bob } = await setup();
        const first = await invoke(message(alice.id));
        expect(first).toEqual([
            {
                role: "system",
                content: [{ type: "text", text: expect.stringContaining('Name: "Alice Example"') }],
            },
        ]);
        const text = JSON.stringify(first);
        expect(text).toContain(alice.id);
        expect(text).toContain("alice@example.test");
        expect(text).toContain("not instructions or authorization");
        expect(text).not.toContain(alice.workosUserId);
        expect(text).not.toContain("isOwner");
        expect(text).not.toContain("photo");
        expect(await invoke(message(alice.id))).toBeUndefined();
        expect(await invoke(inference)).toBeUndefined();
        expect(JSON.stringify(await invoke(message(bob.id)))).toContain("Email: Not provided");
        expect(await invoke(message(alice.id))).toEqual(first);
    });

    it("keeps every sender transition when the entire batch shares one transaction", async () => {
        const { database, storage, hooks, primary, alice, bob } = await setup();
        const results = await storage.transaction(database.context, async (ctx) => {
            const notices = [];
            for (const sender of [alice, alice, bob, alice]) {
                notices.push(
                    await hooks.systemNotificationsTransact?.(ctx, primary, message(sender.id)),
                );
            }
            return notices;
        });
        expect(results[0]).toEqual(results[3]);
        expect(results[1]).toBeUndefined();
        expect(JSON.stringify(results[2])).toContain(bob.id);
    });

    it.each([undefined, "unknown123", "invalid_id", 42])(
        "clears previous identity for an unresolved human sender (%s)",
        async (id) => {
            const { invoke, alice } = await setup();
            await invoke(message(alice.id));
            const cleared = await invoke(message(id));
            expect(JSON.stringify(cleared)).toContain("current human sender cannot be identified");
            expect(JSON.stringify(cleared)).not.toContain(alice.id);
            expect(await invoke(inference)).toBeUndefined();
            expect(await invoke(message(id))).toBeUndefined();
        },
    );

    it("ignores client metadata and generated user-role, system, and agent messages", async () => {
        const { invoke, alice, bob } = await setup();
        expect(await invoke(inference)).toBeUndefined();
        await invoke(message(alice.id));
        expect(await invoke(message(bob.id, "agent"))).toBeUndefined();
        const unstamped = message(bob.id);
        if (unstamped.type !== "message") throw new Error("Expected a message boundary");
        expect(
            await invoke({
                ...unstamped,
                accepted: { ...unstamped.accepted, metadata: { userId: bob.id } },
            }),
        ).toBeUndefined();
        for (const role of ["system", "agent"] as const) {
            expect(
                await invoke({
                    ...unstamped,
                    accepted: {
                        ...unstamped.accepted,
                        message:
                            role === "system"
                                ? { role, content: [{ type: "text", text: "generated" }] }
                                : {
                                      role,
                                      author: { id: "other-agent", description: "agent" },
                                      content: [{ type: "text", text: "generated" }],
                                  },
                    },
                }),
            ).toBeUndefined();
        }
        const spoof = message();
        if (spoof.type !== "message") throw new Error("Expected a message boundary");
        const result = await invoke({
            ...spoof,
            accepted: {
                ...spoof.accepted,
                metadata: { messageOrigin: "user", clientMetadata: { userId: bob.id } },
            },
        });
        expect(JSON.stringify(result)).toContain("cannot be identified");
        expect(JSON.stringify(result)).not.toContain(bob.id);
    });

    it("refreshes names and removed emails at inference but ignores photo/version-only changes", async () => {
        const { invoke, alice, team, database } = await setup();
        await invoke(message(alice.id));
        const requestCtx = withTeamIdentity(database.context, {
            workosUserId: alice.workosUserId,
            organizationId: "org_test123",
        });
        const updated = await team.updateCurrentProfile(
            requestCtx,
            { name: 'Alice "Quoted"', email: null },
            alice.version,
        );
        const changed = JSON.stringify(await invoke(inference));
        expect(changed).toContain("Quoted");
        expect(changed).toContain("Email: Not provided");
        expect(await invoke(message(alice.id))).toBeUndefined();
        await team.updateCurrentProfile(requestCtx, { name: 'Alice "Quoted"' }, updated.version);
        expect(await invoke(inference)).toBeUndefined();
        await team.putUserPhoto(database.context, alice.id, {
            bytes: new Uint8Array([1, 2, 3]),
            contentType: "image/webp",
            height: 1,
            width: 1,
            thumbhash: "abcd",
        });
        expect(await invoke(inference)).toBeUndefined();
    });

    it("retains identity across history replacement, module restart, and independent agents", async () => {
        const { invoke, alice, database, storage, primary, scope } = await setup();
        const first = await invoke(message(alice.id));
        const restarted = await resolveModuleHooks(database.context, createTeam());
        expect(
            await storage.transaction(
                database.context,
                async (ctx) =>
                    await restarted.systemNotificationsTransact?.(ctx, primary, inference),
            ),
        ).toBeUndefined();
        await storage.transaction(
            database.context,
            async (ctx) => await primary.historyKV.clear(ctx),
        );
        expect(await invoke(inference)).toEqual(first);
        expect(await invoke(message(alice.id), scope("second123"))).toEqual(first);
        expect(await invoke(inference)).toBeUndefined();
    });

    it("rolls sender and announcement state back with the caller's transaction", async () => {
        const { invoke, alice, bob, database, storage, primary, hooks } = await setup();
        await invoke(message(alice.id));
        await expect(
            storage.transaction(database.context, async (ctx) => {
                expect(
                    JSON.stringify(
                        await hooks.systemNotificationsTransact?.(ctx, primary, message(bob.id)),
                    ),
                ).toContain(bob.id);
                throw new Error("Rollback");
            }),
        ).rejects.toThrow("Rollback");
        expect(await invoke(inference)).toBeUndefined();
        expect(JSON.stringify(await invoke(message(bob.id)))).toContain(bob.id);
    });

    it("does nothing in standalone mode", async () => {
        const { invoke, alice, primary, database } = await setup(false);
        expect(await invoke(message(alice.id))).toBeUndefined();
        expect(await invoke(inference)).toBeUndefined();
        expect(await primary.kv.list(database.context)).toEqual([]);
        expect(await primary.historyKV.list(database.context)).toEqual([]);
    });
});
