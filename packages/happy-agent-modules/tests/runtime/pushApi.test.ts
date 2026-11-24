import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
    type PreparedHappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

/**
 * The phone's connection to the fixture server. An agent of its own takes no proxy from the
 * environment, where the default one and `fetch` do under `NODE_USE_ENV_PROXY`, so the loopback
 * requests reach the daemon whatever proxy the machine running the test is configured with.
 */
const direct = new Agent();

let runtime: HappyAgentRuntime | undefined;
let server: Server | undefined;
let root: string | undefined;

async function stop() {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await runtime?.close();
    runtime = undefined;
}

afterEach(async () => {
    await stop();
    direct.destroy();
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THIRTY_DAYS = 2_592_000_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = (n: number) => `HappyPushToken[phone${String(n).padStart(17, "0")}]`;
const phone = (n: number) => ({ token: token(n), platform: "ios", appId: "com.ex3ndr.happy" });

it("serves Happy Cloud's push registration contract to each team member's phone", async () => {
    root = await mkdtemp(join(tmpdir(), "team-push-"));
    const happyHome = join(root, ".happy");
    const configPath = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "happy.toml",
    );
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
        configPath,
        [
            "[feature.team]",
            "enabled = true",
            'host = "127.0.0.1"',
            "port = 0",
            'workos_organization_id = "org_push"',
            'owner_workos_user_id = "user_alice"',
        ].join("\n"),
    );
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "push", use: "sig" };
    const nativeFetch = globalThis.fetch;
    const relay: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.workos.com/sso/jwks/")) {
            return Promise.resolve(Response.json({ keys: [jwk] }));
        }
        if (url === "https://push.cluster-fluster.com/v1/push/send") {
            relay.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Promise.resolve(Response.json({ data: [{ status: "ok", id: "ticket-1" }] }));
        }
        return nativeFetch(input, init);
    });
    const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
    const bearer = (subject: string) =>
        new SignJWT({ client_id: clientId, org_id: "org_push", sid: "session_push" })
            .setProtectedHeader({ alg: "RS256", kid: "push" })
            .setIssuer(`https://api.workos.com/user_management/${clientId}`)
            .setSubject(subject)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
    const [aliceToken, bobToken, carolToken] = await Promise.all([
        bearer("user_alice"),
        bearer("user_bob"),
        bearer("user_carol"),
    ]);

    let endpoint = "";
    let databaseContext: PreparedHappyAgentRuntime["context"] | undefined;
    const start = async () => {
        const providers = new AgentProviders();
        providers.add("gym", new ScriptedProvider([]), "codex");
        runtime = await startHappyAgentRuntime({
            happyHome,
            inference: {
                providers,
                models: [
                    {
                        id: "gym/model",
                        providerId: "gym",
                        name: "Gym",
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                    },
                ],
            },
            onPrepared: async (prepared) => {
                databaseContext = (name) => prepared.context(name);
                server = createServer((request, response) => {
                    void prepared.api.handleRequest(
                        prepared.context("test.http"),
                        request,
                        response,
                    );
                });
                await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
                const address = server.address();
                if (!address || typeof address === "string")
                    throw new Error("Missing fixture address.");
                endpoint = `http://127.0.0.1:${address.port}`;
            },
        });
    };
    /** One request as a phone sends it, answered with its status and its body as text and JSON. */
    const call = async (
        bearerToken: string,
        method: string,
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
    ) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const { status, text } = await new Promise<{ status: number; text: string }>(
            (resolve, reject) => {
                const outgoing = httpRequest(
                    `${endpoint}${path}`,
                    {
                        agent: direct,
                        method,
                        headers: {
                            authorization: `Bearer ${bearerToken}`,
                            ...(payload === undefined
                                ? {}
                                : { "content-type": "application/json" }),
                            ...headers,
                        },
                    },
                    (incoming) => {
                        const chunks: Buffer[] = [];
                        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                        incoming.on("error", reject);
                        incoming.on("end", () =>
                            resolve({
                                status: incoming.statusCode ?? 0,
                                text: Buffer.concat(chunks).toString("utf8"),
                            }),
                        );
                    },
                );
                outgoing.on("error", reject);
                outgoing.end(payload);
            },
        );
        return {
            status,
            text,
            json: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
        };
    };
    const everyAnswer: string[] = [];
    const as = (bearerToken: string) => ({
        register: async (n: number, body: unknown = phone(n)) => {
            const answer = await call(
                bearerToken,
                "PUT",
                `/v0/cloud/push/registrations/${id(n)}`,
                body,
            );
            everyAnswer.push(answer.text);
            return answer;
        },
        unregister: (n: number, version?: string) =>
            call(
                bearerToken,
                "DELETE",
                `/v0/cloud/push/registrations/${id(n)}`,
                undefined,
                version === undefined ? {} : { "if-match": version },
            ),
        settings: () => call(bearerToken, "GET", "/v0/cloud/push/settings"),
        saveSettings: (body: unknown) => call(bearerToken, "PUT", "/v0/cloud/push/settings", body),
    });

    await start();
    const alice = as(aliceToken);
    const bob = as(bobToken);
    const userIds: Record<string, string> = {};
    for (const [bearerToken, name] of [
        [aliceToken, "Alice"],
        [bobToken, "Bob"],
    ] as const) {
        const profile = (await call(bearerToken, "GET", "/v0/profile")).json!.profile as {
            version: string;
        };
        const saved = await call(
            bearerToken,
            "PATCH",
            "/v0/profile",
            { name },
            {
                "if-match": profile.version,
            },
        );
        userIds[name] = (saved.json!.profile as { userId: string }).userId;
    }

    const health = (await call(aliceToken, "GET", "/v0/health")).json!;
    expect((health.capabilities as Record<string, unknown>).pushRegistrations).toBe(true);

    // A member who has not saved a profile has no push registration or settings yet.
    expect((await as(carolToken).register(1)).status).toBe(401);
    expect((await as(carolToken).settings()).status).toBe(401);

    const before = Date.now();
    const registered = await alice.register(1, { ...phone(1), locale: "en-US" });
    expect(registered.status).toBe(200);
    expect(registered.json).toEqual({
        registration: {
            id: "00000000-0000-4000-8000-000000000001",
            version: expect.stringMatching(UUID),
            expiresAt: expect.any(Number),
        },
    });
    const first = registered.json!.registration as { version: string; expiresAt: number };
    expect(first.expiresAt).toBeGreaterThanOrEqual(before + THIRTY_DAYS);
    expect(first.expiresAt).toBeLessThanOrEqual(Date.now() + THIRTY_DAYS);

    const renewed = (await alice.register(1)).json!.registration as { version: string };
    expect(renewed.version).toMatch(UUID);
    expect(renewed.version).not.toBe(first.version);

    // Another member's ID answers 404, and their phone stays theirs.
    const taken = await bob.register(1, phone(2));
    expect(taken.status).toBe(404);
    expect(taken.json).toEqual({ error: "No such push registration.", code: "not_found" });

    for (const [body, path] of [
        [{ ...phone(3), token: "ExponentPushToken[aB3dE6gH9jK2mN5pQ8sT1v]" }, id(3)],
        [{ ...phone(3), platform: "web" }, id(3)],
        [{ ...phone(3), extra: true }, id(3)],
        [phone(3), "not-a-uuid"],
    ] as const) {
        const refused = await call(aliceToken, "PUT", `/v0/cloud/push/registrations/${path}`, body);
        everyAnswer.push(refused.text);
        expect(refused.status).toBe(400);
        expect(refused.json!.code).toBe("invalid_request");
    }

    // Stricter than Happy Cloud, and specified: a JSON content type and a 4,096-byte body.
    const untyped = await call(
        aliceToken,
        "PUT",
        `/v0/cloud/push/registrations/${id(3)}`,
        phone(3),
        {
            "content-type": "text/plain",
        },
    );
    expect([untyped.status, untyped.json]).toEqual([
        400,
        { error: "The request content type must be application/json.", code: "invalid_request" },
    ]);
    const oversized = await alice.register(3, { ...phone(3), locale: "x".repeat(4096) });
    expect([oversized.status, oversized.json]).toEqual([
        413,
        { error: "The request body is too large.", code: "too_large" },
    ]);
    const untypedSettings = await call(
        aliceToken,
        "PUT",
        "/v0/cloud/push/settings",
        { enabled: false },
        {
            "content-type": "text/plain",
        },
    );
    expect(untypedSettings.status).toBe(400);
    expect((await alice.settings()).json).toEqual({ enabled: true });
    everyAnswer.push(untyped.text);

    for (let n = 2; n <= 20; n += 1) expect((await alice.register(n)).status).toBe(200);
    const full = await alice.register(21);
    expect(full.status).toBe(409);
    expect(full.json).toEqual({
        error: "You already have 20 phones registered for notifications. Remove one before adding another.",
        code: "conflict",
    });
    expect((await bob.register(21)).status).toBe(200);
    // A null locale means none, as on Happy Cloud.
    expect((await bob.register(21, { ...phone(21), locale: null })).status).toBe(200);

    // The token is a send capability: no answer ever repeats one.
    expect(everyAnswer.join("\n")).not.toContain("HappyPushToken");
    expect(everyAnswer.join("\n")).not.toContain("ExponentPushToken");

    expect((await alice.settings()).json).toEqual({ enabled: true });
    const disabled = await alice.saveSettings({ enabled: false });
    expect([disabled.status, disabled.json]).toEqual([200, { enabled: false }]);
    expect((await alice.settings()).json).toEqual({ enabled: false });
    expect((await bob.settings()).json).toEqual({ enabled: true });
    expect((await alice.saveSettings({ enabled: "no" })).status).toBe(400);
    expect((await alice.saveSettings({ enabled: true })).json).toEqual({ enabled: true });

    // Removal: the stale version removes nothing, the current one removes, and again is still 204.
    expect((await alice.unregister(1)).status).toBe(400);
    expect((await alice.unregister(1, "not-a-version")).status).toBe(400);
    const stale = await alice.unregister(1, first.version);
    expect([stale.status, stale.text]).toEqual([204, ""]);
    expect((await bob.unregister(1, renewed.version)).status).toBe(204);
    expect((await alice.register(22)).status).toBe(409);
    const removed = await alice.unregister(1, renewed.version);
    expect([removed.status, removed.text]).toEqual([204, ""]);
    expect((await alice.unregister(1, renewed.version)).status).toBe(204);
    expect((await alice.register(22)).status).toBe(200);

    // The version is a UUID in either letter case, as Happy Cloud reads it, and still removes.
    const second = (await alice.register(2)).json!.registration as { version: string };
    const uppercase = await alice.unregister(2, second.version.toUpperCase());
    expect([uppercase.status, uppercase.text]).toEqual([204, ""]);
    expect((await alice.register(24)).status).toBe(200);

    expect((await call(aliceToken, "GET", "/v0/cloud/push/registrations")).status).toBe(404);
    expect((await call(aliceToken, "GET", `/v0/cloud/push/registrations/${id(2)}`)).status).toBe(
        404,
    );

    // Registrations and settings survive a restart, and a notification reaches only its person.
    await stop();
    await start();
    expect((await alice.register(23)).status).toBe(409);
    expect((await bob.settings()).json).toEqual({ enabled: true });
    await runtime!.modules.push.send(databaseContext!("test.push"), userIds.Bob!, {
        notificationId: "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f",
        title: "Found why cloud replies show twice",
        body: "Fix and test ready, uncommitted. Open a PR?",
        agentId: "pfh0haxfpzowht3oi213cqos",
    });
    await vi.waitFor(() => expect(relay).toHaveLength(1), { timeout: 10_000 });
    expect(relay).toEqual([
        {
            to: token(21),
            title: "Found why cloud replies show twice",
            body: "Fix and test ready, uncommitted. Open a PR?",
            data: {
                kind: "happy.cloud.push.v1",
                instanceId: health.instanceId,
                userId: userIds.Bob,
                agentId: "pfh0haxfpzowht3oi213cqos",
                notificationId: "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f",
            },
            sound: "default",
            channelId: "messages",
            ttl: 300,
        },
    ]);
    expect(health.instanceId).toMatch(/^[a-z][a-z0-9]{23}$/);
}, 60_000);
