import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const servers: Server[] = [];
let runtime: HappyAgentRuntime | undefined;
let root: string | undefined;

afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.unstubAllGlobals();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address.");
    return `http://127.0.0.1:${address.port}`;
}

describe("personal mobile pairing through the team HTTP API", () => {
    it("isolates pairing, bootstrap, pulls, live and replayed events, cancellation and restart without new wire fields", async () => {
        root = await mkdtemp(join(tmpdir(), "team-mobile-"));
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
                'workos_organization_id = "org_mobile"',
                'owner_workos_user_id = "user_alice"',
            ].join("\n"),
        );
        const mobileUrl = await listen(
            createServer((request, response) => {
                request.resume();
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ state: "requested" }));
            }),
        );
        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "mobile", use: "sig" };
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
            String(input).includes("api.workos.com/sso/jwks/")
                ? Promise.resolve(Response.json({ keys: [jwk] }))
                : nativeFetch(input, init),
        );
        const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
        const token = (subject: string) =>
            new SignJWT({ client_id: clientId, org_id: "org_mobile", sid: "mobile" })
                .setProtectedHeader({ alg: "RS256", kid: "mobile" })
                .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey);
        const [aliceToken, bobToken] = await Promise.all([token("user_alice"), token("user_bob")]);
        const start = async () => {
            let endpoint = "";
            const providers = new AgentProviders();
            providers.add("gym", new ScriptedProvider([]), "codex");
            runtime = await startHappyAgentRuntime({
                happyHome,
                environment: { HAPPY_HOME_DIR: happyHome, HAPPY_AGENT_HAPPY_SERVER_URL: mobileUrl },
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
                    endpoint = await listen(
                        createServer((request, response) => {
                            void prepared.api.handleRequest(
                                prepared.context("test.http"),
                                request,
                                response,
                            );
                        }),
                    );
                },
            });
            return {
                alice: new HappyAgentClient({ endpoint, token: aliceToken }),
                bob: new HappyAgentClient({ endpoint, token: bobToken }),
            };
        };
        let { alice, bob } = await start();
        for (const [client, name] of [
            [alice, "Alice"],
            [bob, "Bob"],
        ] as const) {
            const current = await client.getProfile();
            await client.updateProfile({ name }, { ifMatch: current.profile.version });
        }
        const original = (await bob.getHappyIntegration()).integration;
        const before = await alice.getDesktopBootstrap();
        const alicePairing = (await alice.startHappyIntegration()).integration;
        expect(alicePairing.status).toBe("pairing");
        expect((await bob.getHappyIntegration()).integration).toEqual(original);
        expect((await bob.getDesktopBootstrap()).happyIntegration).toEqual(original);
        const bobPairing = (await bob.startHappyIntegration()).integration;
        expect(bobPairing.status).toBe("pairing");
        expect(bobPairing.authorization).not.toEqual(alicePairing.authorization);
        expect(Object.keys(bobPairing).sort()).toEqual([
            "authorization",
            "configured",
            "error",
            "status",
            "updatedAt",
            "version",
        ]);
        const bobPage = await bob.getEvents({ after: before.cursor });
        expect(
            bobPage.events
                .filter((event) => event.type === "happy.integration.updated")
                .map((event) => event.payload),
        ).toEqual([{ integration: bobPairing }]);
        const abort = new AbortController();
        const frames = alice.streamEvents({ after: before.cursor, signal: abort.signal });
        try {
            expect((await frames.next()).value?.kind).toBe("hello");
            const first = (await frames.next()).value;
            expect(first).toMatchObject({
                kind: "event",
                event: {
                    type: "happy.integration.updated",
                    payload: { integration: alicePairing },
                },
            });
            await bob.cancelHappyIntegration();
            const cancelled = (await alice.cancelHappyIntegration()).integration;
            const live = (await frames.next()).value;
            expect(live).toMatchObject({
                kind: "event",
                event: { type: "happy.integration.updated", payload: { integration: cancelled } },
            });
        } finally {
            abort.abort();
            await frames.return(undefined);
        }
        const aliceAgain = (await alice.startHappyIntegration()).integration;
        const bobAgain = (await bob.startHappyIntegration()).integration;
        await alice.disconnectHappyIntegration();
        expect((await bob.getHappyIntegration()).integration).toEqual(bobAgain);
        const beforeRestart = bobAgain.version;
        await runtime!.close();
        runtime = undefined;
        ({ alice, bob } = await start());
        expect((await alice.getHappyIntegration()).integration.status).toBe("disconnected");
        const afterRestart = (await bob.getHappyIntegration()).integration;
        expect(afterRestart.status).toBe("disconnected");
        expect(afterRestart.version > beforeRestart).toBe(true);
        expect((await alice.getHappyIntegration()).integration.version > aliceAgain.version).toBe(
            true,
        );
    }, 30_000);
});
