import { inspect } from "node:util";

import { ensureAgentDatabaseConnection, type AgentSystemRef } from "@slopus/happy-agent-base";
import { withLogger, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { PushError, PushModule, type PushNotification } from "../../sources/push/index.js";
import {
    TeamAuthenticationError,
    TeamModule,
    withTeamUser,
    type TeamUser,
} from "../../sources/team/index.js";
import {
    pendingCallCount,
    waitForCondition,
} from "../durableFunctions/support/durableFunctionsHarness.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { testProfileModule } from "../support/testProfileModule.js";

const NOW = 1_700_000_000_000;
const THIRTY_DAYS = 2_592_000_000;
const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const ALICE = "alice0000000000000000001";
const BOB = "bob000000000000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELAY = "https://push.cluster-fluster.com/v1/push/send";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = (n: number) => `HappyPushToken[phone${String(n).padStart(17, "0")}]`;
const phone = (n: number) => ({ token: token(n), platform: "ios", appId: "com.ex3ndr.happy" });
const notice: PushNotification = {
    notificationId: "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f",
    title: "iOS preview 24 uploaded; prod is blocked",
    body: "Prod needs build number 164 committed on main first",
    agentId: "pfh0haxfpzowht3oi213cqos",
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("registers a phone for 30 days and renews it under a new version", async () => {
    const world = await startWorld("push-register", { team: false });
    try {
        const first = await world.push.register(world.ctx, id(1), { ...phone(1), locale: "en-US" });
        expect(first).toEqual({
            id: "00000000-0000-4000-8000-000000000001",
            version: expect.stringMatching(UUID),
            expiresAt: 1_702_592_000_000,
        });

        vi.setSystemTime(NOW + 1_000);
        const renewed = await world.push.register(world.ctx, id(1), phone(1));
        expect(renewed).toEqual({
            id: "00000000-0000-4000-8000-000000000001",
            version: expect.stringMatching(UUID),
            expiresAt: 1_702_592_001_000,
        });
        expect(renewed.version).not.toBe(first.version);

        // Renewing kept one registration: one notification reaches the relay once.
        const relay = stubRelay();
        await world.send("standalone", notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);
    } finally {
        world.close();
    }
});

it("replaces the registration a reinstalled app left under its old ID", async () => {
    const world = await startWorld("push-reinstall", { team: false });
    try {
        const old = await world.push.register(world.ctx, id(1), phone(1));
        const reinstalled = await world.push.register(world.ctx, id(2), phone(1));
        const relay = stubRelay();

        // One phone, one request: the old registration did not survive beside the new one.
        await world.send("standalone", notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);

        await world.push.unregister(world.ctx, id(1), old.version);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(2);

        await world.push.unregister(world.ctx, id(2), reinstalled.version);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(2);
    } finally {
        world.close();
    }
});

it("holds at most 20 phones for one person and lets expired ones go first", async () => {
    const world = await startWorld("push-limit", { team: true });
    const alice = member(world.ctx, ALICE);
    const bob = member(world.ctx, BOB);
    try {
        for (let n = 1; n <= 20; n += 1) await world.push.register(alice, id(n), phone(n));

        const refused = await world.push.register(alice, id(21), phone(21)).catch((e) => e);
        expect(refused).toBeInstanceOf(PushError);
        expect(refused).toMatchObject({
            code: "registrations_full",
            message:
                "You already have 20 phones registered for notifications. Remove one before adding another.",
        });

        // Renewing one of the 20 is still accepted, and the limit is each person's own.
        expect((await world.push.register(alice, id(20), phone(20))).id).toBe(id(20));
        expect((await world.push.register(bob, id(21), phone(21))).id).toBe(id(21));

        // The first 19 expire a second before the renewed one does.
        vi.setSystemTime(NOW + THIRTY_DAYS);
        expect((await world.push.register(alice, id(22), phone(22))).expiresAt).toBe(
            NOW + 2 * THIRTY_DAYS,
        );
    } finally {
        world.close();
    }
});

it("never lets one person replace, remove, or receive on another person's phone", async () => {
    const world = await startWorld("push-owners", { team: true });
    const alice = member(world.ctx, ALICE);
    const bob = member(world.ctx, BOB);
    try {
        const hers = await world.push.register(alice, id(1), phone(1));

        const taken = await world.push.register(bob, id(1), phone(2)).catch((e) => e);
        expect(taken).toBeInstanceOf(PushError);
        expect(taken).toMatchObject({ code: "not_found", message: "No such push registration." });
        await world.push.unregister(bob, id(1), hers.version);

        const relay = stubRelay();
        await world.send(BOB, notice);
        expect(relay).toEqual([]);
        await world.send(ALICE, notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);

        // Two people signed in on one phone each hold their own registration of it.
        await world.push.register(bob, id(2), phone(1));
        await world.send(BOB, notice);
        expect(relay.map((request) => request.body.data)).toEqual([
            expect.objectContaining({ userId: ALICE }),
            expect.objectContaining({ userId: BOB }),
        ]);

        await expect(world.push.register(world.ctx, id(3), phone(3))).rejects.toThrow(
            TeamAuthenticationError,
        );
        await expect(world.push.settings(world.ctx)).rejects.toThrow(TeamAuthenticationError);
    } finally {
        world.close();
    }
});

it("removes a registration only at its current version, and removing again still succeeds", async () => {
    const world = await startWorld("push-unregister", { team: false });
    try {
        const first = await world.push.register(world.ctx, id(1), phone(1));
        const renewed = await world.push.register(world.ctx, id(1), phone(1));
        const relay = stubRelay();

        // A stale phone holding the first version does not remove the renewed registration.
        await world.push.unregister(world.ctx, id(1), first.version);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(1);

        await world.push.unregister(world.ctx, id(1), renewed.version);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(1);

        expect(await world.push.unregister(world.ctx, id(1), renewed.version)).toBeUndefined();
    } finally {
        world.close();
    }
});

it("removes a registration whose version arrives in another letter case", async () => {
    const world = await startWorld("push-unregister-case", { team: false });
    try {
        const { version } = await world.push.register(world.ctx, id(1), phone(1));
        const relay = stubRelay();
        expect(version.toUpperCase()).not.toBe(version);

        await world.push.unregister(world.ctx, id(1), version.toUpperCase());
        await world.send("standalone", notice);
        expect(relay).toEqual([]);
    } finally {
        world.close();
    }
});

it.each([
    ["an uppercase ID", id(1).replace("4000", "4AAA"), phone(1)],
    ["an ID without hyphens", id(1).replaceAll("-", ""), phone(1)],
    ["an Expo token", id(1), { ...phone(1), token: "ExponentPushToken[aB3dE6gH9jK2mN5pQ8sT1v]" }],
    ["a missing token", id(1), { platform: "ios", appId: "com.ex3ndr.happy" }],
    ["an unknown platform", id(1), { ...phone(1), platform: "web" }],
    ["another app", id(1), { ...phone(1), appId: "com.example.other" }],
    ["an empty locale", id(1), { ...phone(1), locale: "" }],
    ["a locale with a control character", id(1), { ...phone(1), locale: "en\u0007US" }],
    ["a locale over 64 characters", id(1), { ...phone(1), locale: "x".repeat(65) }],
    ["a locale with half of a surrogate pair", id(1), { ...phone(1), locale: "en\ud83d" }],
    [
        "a locale over 64 characters outside the Basic Multilingual Plane",
        id(1),
        { ...phone(1), locale: "😀".repeat(65) },
    ],
    ["an unknown field", id(1), { ...phone(1), mutationId: "m" }],
    ["a body that is not an object", id(1), token(1)],
])(
    "refuses a registration with %s and never repeats the token",
    async (_name, registrationId, body) => {
        const world = await startWorld("push-invalid", { team: false });
        try {
            const refused = await world.push
                .register(world.ctx, registrationId, body)
                .catch((e) => e);
            expect(refused).toBeInstanceOf(PushError);
            expect(refused.code).toBe("invalid_request");
            expect(refused.message).not.toContain("HappyPushToken");
            expect(refused.message).not.toContain("ExponentPushToken");
        } finally {
            world.close();
        }
    },
);

it("accepts a 64-character locale counted in characters, not UTF-16 units", async () => {
    const world = await startWorld("push-locale", { team: false });
    try {
        const registered = await world.push.register(world.ctx, id(1), {
            ...phone(1),
            platform: "android",
            appId: "com.slopus.happy.dev",
            locale: "😀".repeat(64),
        });
        expect(registered.id).toBe(id(1));
    } finally {
        world.close();
    }
});

it("takes a null locale as no locale, as Happy Cloud does", async () => {
    const world = await startWorld("push-locale-null", { team: false });
    try {
        const registered = await world.push.register(world.ctx, id(1), {
            ...phone(1),
            locale: null,
        });
        expect(registered.id).toBe(id(1));
    } finally {
        world.close();
    }
});

it("refuses a removal whose ID or version is not a UUID", async () => {
    const world = await startWorld("push-unregister-invalid", { team: false });
    try {
        const { version } = await world.push.register(world.ctx, id(1), phone(1));
        await expect(world.push.unregister(world.ctx, "phone-1", version)).rejects.toMatchObject({
            code: "invalid_request",
            message: "A registration ID must be a lowercase UUID.",
        });
        await expect(world.push.unregister(world.ctx, id(1), "*")).rejects.toMatchObject({
            code: "invalid_request",
            message: "The registration version must be a UUID.",
        });
    } finally {
        world.close();
    }
});

it("keeps each person's push settings, enabled until they turn them off", async () => {
    const world = await startWorld("push-settings", { team: true });
    const alice = member(world.ctx, ALICE);
    const bob = member(world.ctx, BOB);
    try {
        expect(await world.push.settings(alice)).toEqual({ enabled: true });
        expect(await world.push.saveSettings(alice, { enabled: false })).toEqual({
            enabled: false,
        });
        expect(await world.push.settings(alice)).toEqual({ enabled: false });
        expect(await world.push.settings(bob)).toEqual({ enabled: true });
        expect(await world.push.saveSettings(alice, { enabled: true })).toEqual({ enabled: true });
        expect(await world.push.settings(alice)).toEqual({ enabled: true });

        for (const invalid of [{}, { enabled: "no" }, { enabled: false, sound: true }, null]) {
            await expect(world.push.saveSettings(alice, invalid)).rejects.toMatchObject({
                code: "invalid_request",
                message: "The push settings are invalid.",
            });
        }
        expect(await world.push.settings(alice)).toEqual({ enabled: true });
    } finally {
        world.close();
    }
});

it("sends each phone exactly the relay request the phone expects", async () => {
    const world = await startWorld("push-wire", { team: true });
    try {
        await world.push.register(member(world.ctx, ALICE), id(1), phone(1));
        const relay = stubRelay();

        await world.send(ALICE, notice);
        await world.send(ALICE, { ...notice, body: "", collapseId: "k3x9q2m7_pfh0haxf-1" });

        expect(relay).toEqual([
            {
                url: RELAY,
                method: "POST",
                contentType: "application/json",
                redirect: "manual",
                body: {
                    to: "HappyPushToken[phone00000000000000001]",
                    title: "iOS preview 24 uploaded; prod is blocked",
                    body: "Prod needs build number 164 committed on main first",
                    data: {
                        kind: "happy.cloud.push.v1",
                        instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2",
                        userId: "alice0000000000000000001",
                        agentId: "pfh0haxfpzowht3oi213cqos",
                        notificationId: "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f",
                    },
                    sound: "default",
                    channelId: "messages",
                    ttl: 300,
                },
            },
            {
                url: RELAY,
                method: "POST",
                contentType: "application/json",
                redirect: "manual",
                body: {
                    to: "HappyPushToken[phone00000000000000001]",
                    title: "iOS preview 24 uploaded; prod is blocked",
                    body: "",
                    data: {
                        kind: "happy.cloud.push.v1",
                        instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2",
                        userId: "alice0000000000000000001",
                        agentId: "pfh0haxfpzowht3oi213cqos",
                        notificationId: "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f",
                    },
                    collapseId: "k3x9q2m7_pfh0haxf-1",
                    sound: "default",
                    channelId: "messages",
                    ttl: 300,
                },
            },
        ]);
    } finally {
        world.close();
    }
});

it("names the standalone person in the payload and sends one request per phone", async () => {
    const world = await startWorld("push-standalone", { team: false });
    try {
        await world.push.register(world.ctx, id(2), phone(2));
        await world.push.register(world.ctx, id(1), phone(1));
        const relay = stubRelay();

        await world.send("standalone", notice);

        expect(relay.map((request) => [request.body.to, request.body.data?.userId])).toEqual([
            [token(1), "standalone"],
            [token(2), "standalone"],
        ]);
    } finally {
        world.close();
    }
});

it("removes the phone the relay no longer knows and keeps the others", async () => {
    const world = await startWorld("push-unregistered", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1));
        await world.push.register(world.ctx, id(2), phone(2));
        const relay = stubRelay((body) =>
            body.to === token(1)
                ? Response.json({
                      data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
                  })
                : Response.json({
                      data: [{ status: "error", details: { error: "MessageTooBig" } }],
                  }),
        );

        await world.send("standalone", notice);
        await world.send("standalone", notice);

        // The first phone was removed after its one answer; a refusal leaves the second in place.
        expect(relay.map((request) => request.body.to)).toEqual([token(1), token(2), token(2)]);
    } finally {
        world.close();
    }
});

it("sends nothing while the person has turned push off, has no phone, or has only expired ones", async () => {
    const world = await startWorld("push-nothing", { team: false });
    try {
        const relay = stubRelay();
        await world.send("standalone", notice);
        expect(relay).toEqual([]);

        await world.push.register(world.ctx, id(1), phone(1));
        await world.push.saveSettings(world.ctx, { enabled: false });
        await world.send("standalone", notice);
        expect(relay).toEqual([]);

        await world.push.saveSettings(world.ctx, { enabled: true });
        await world.send("standalone", notice);
        expect(relay).toHaveLength(1);

        // Waiting for a delivery moves the test clock, so step well past the expiry.
        vi.setSystemTime(NOW + THIRTY_DAYS + 60_000);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(1);
    } finally {
        world.close();
    }
});

it("sends only after its caller's transaction commits, and never after a rollback", async () => {
    const world = await startWorld("push-transaction", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1));
        const relay = stubRelay();

        await expect(
            world.ctx.inTx(async (txCtx) => {
                await world.push.send(txCtx, "standalone", notice);
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        await world.settle();
        expect(relay).toEqual([]);

        await world.ctx.inTx(async (txCtx) => {
            await world.push.send(txCtx, "standalone", notice);
            expect(relay).toEqual([]);
        });
        await world.settle();
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);
    } finally {
        world.close();
    }
});

it("carries on after a restart without sending any phone a second request", async () => {
    const database = pushDatabase("push-restart");
    const first = await startWorld("push-restart", { team: false, database });
    await first.push.register(first.ctx, id(1), phone(1));
    await first.push.register(first.ctx, id(2), phone(2));
    const before = stubRelay(
        (_body, signal) =>
            new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason));
            }),
    );
    await first.push.send(first.ctx, "standalone", notice);
    await waitForCondition(() => before.length === 1);
    first.stop();

    const second = await startWorld("push-restart", { team: false, database });
    try {
        const after = stubRelay();
        await second.settle();

        expect(before.map((request) => request.body.to)).toEqual([token(1)]);
        expect(after.map((request) => request.body.to)).toEqual([token(2)]);
    } finally {
        second.close();
    }
});

it("never writes a token to a log line", async () => {
    const world = await startWorld("push-logs", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1));
        await world.push.register(world.ctx, id(2), phone(2));
        await world.push.register(world.ctx, id(3), phone(3));
        stubRelay((body) =>
            body.to === token(1)
                ? Response.json({ data: [{ status: "ok", id: "ticket-1" }] })
                : body.to === token(2)
                  ? Response.json({
                        data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
                    })
                  : new Response(`refused ${String(body.to)}`, { status: 400 }),
        );

        await world.send("standalone", notice);

        expect(world.logs).toEqual([
            `push:delivery outcome=accepted registrationId=${id(1)} notificationId=${notice.notificationId} agentId=${notice.agentId}`,
            `push:delivery outcome=unregistered registrationId=${id(2)} notificationId=${notice.notificationId} agentId=${notice.agentId}`,
            `push:delivery outcome=request_rejected registrationId=${id(3)} notificationId=${notice.notificationId} agentId=${notice.agentId}`,
        ]);
        expect(world.logs.join("\n")).not.toContain("HappyPushToken");
    } finally {
        world.close();
    }
});

interface RelayRequest {
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
function stubRelay(
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

function pushDatabase(name: string): ModuleDatabase {
    const durable = new DurableFunctionsModule();
    const push = new PushModule(createTeam(false), config, durable);
    const database = moduleDatabase([...durable.migrations, ...push.migrations], name);
    ensureAgentDatabaseConnection(database.database);
    return database;
}

/** A push module on a started Durable Functions module, as the daemon runs them. */
async function startWorld(
    name: string,
    options: { readonly team: boolean; readonly database?: ModuleDatabase },
) {
    const durable = new DurableFunctionsModule();
    const push = new PushModule(createTeam(options.team), config, durable);
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
    const agents = {} as AgentSystemRef;
    const hooks = await resolveModuleHooks(ctx, durable, agents);
    await hooks.afterStart?.(ctx, agents);
    const settle = async () => {
        await waitForCondition(async () => (await pendingCallCount(ctx)) === 0);
    };
    return {
        push,
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

function member(ctx: Context, userId: string): Context {
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
