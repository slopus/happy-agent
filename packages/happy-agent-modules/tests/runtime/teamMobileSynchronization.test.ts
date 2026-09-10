import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { createMobileRelayFixture } from "../support/MobileRelayFixture.js";

describe("parallel personal mobile synchronization", () => {
    it("pairs two accounts, attributes phone messages, reconnects both, and unlinks only the caller", async () => {
        const root = await mkdtemp(join(tmpdir(), "team-mobile-sync-"));
        const relay = await createMobileRelayFixture();
        const servers: Server[] = [];
        let runtime: HappyAgentRuntime | undefined;
        try {
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
            // A shared CLI credential must not be imported into either personal connection.
            await mkdir(happyHome, { recursive: true });
            const external = JSON.stringify({
                token: "external-must-stay-unused",
                secret: Buffer.alloc(32).toString("base64"),
            });
            await writeFile(join(happyHome, "access.key"), external);
            const { privateKey, publicKey } = await generateKeyPair("RS256");
            const jwk = {
                ...(await exportJWK(publicKey)),
                alg: "RS256",
                kid: "mobile-sync",
                use: "sig",
            };
            const nativeFetch = globalThis.fetch;
            vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
                String(input).includes("api.workos.com/sso/jwks/")
                    ? Promise.resolve(Response.json({ keys: [jwk] }))
                    : nativeFetch(input, init),
            );
            const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
            const token = (subject: string) =>
                new SignJWT({ client_id: clientId, org_id: "org_mobile", sid: "mobile-sync" })
                    .setProtectedHeader({ alg: "RS256", kid: "mobile-sync" })
                    .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                    .setSubject(subject)
                    .setIssuedAt()
                    .setExpirationTime("5m")
                    .sign(privateKey);
            const [aliceToken, bobToken] = await Promise.all([
                token("user_alice"),
                token("user_bob"),
            ]);
            const start = async () => {
                let endpoint = "";
                const providers = new AgentProviders();
                providers.add("gym", new ScriptedProvider([]), "codex");
                runtime = await startHappyAgentRuntime({
                    happyHome,
                    environment: {
                        HAPPY_HOME_DIR: happyHome,
                        HAPPY_AGENT_HAPPY_SERVER_URL: relay.url,
                    },
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
                        const server = createServer((request, response) => {
                            void prepared.api.handleRequest(
                                prepared.context("test.mobile-http"),
                                request,
                                response,
                            );
                        });
                        servers.push(server);
                        await new Promise<void>((resolve, reject) => {
                            server.once("error", reject);
                            server.listen(0, "127.0.0.1", resolve);
                        });
                        const address = server.address();
                        if (address === null || typeof address === "string")
                            throw new Error("Missing test address.");
                        endpoint = `http://127.0.0.1:${address.port}`;
                    },
                });
                return {
                    alice: new HappyAgentClient({ endpoint, token: aliceToken }),
                    bob: new HappyAgentClient({ endpoint, token: bobToken }),
                };
            };
            let { alice, bob } = await start();
            const owners: string[] = [];
            for (const [client, name] of [
                [alice, "Alice"],
                [bob, "Bob"],
            ] as const) {
                const initial = await client.getProfile();
                const profile = (
                    await client.updateProfile({ name }, { ifMatch: initial.profile.version })
                ).profile;
                owners.push(profile.userId!);
                expect((await client.getHappyIntegration()).integration.configured).toBe(false);
            }
            expect(relay.machines.size).toBe(0);
            const bot = (await alice.createBot({ name: "Shared mobile bot" })).bot;
            const [alicePairing, bobPairing] = await Promise.all([
                alice.startHappyIntegration(),
                bob.startHappyIntegration(),
            ]);
            relay.authorize(alicePairing.integration.authorization!.data, "alice-mobile");
            relay.authorize(bobPairing.integration.authorization!.data, "bob-mobile");
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration.status).toBe(
                        "connected",
                    );
                    expect((await bob.getHappyIntegration()).integration.status).toBe("connected");
                    expect(relay.activeMachines()).toEqual(["alice-mobile", "bob-mobile"]);
                    expect(
                        [...relay.sessions.values()].filter((session) => session.botId === bot.id),
                    ).toHaveLength(2);
                },
                { timeout: 10_000 },
            );
            expect(new Set(relay.machines.values()).size).toBe(2);
            relay.deliver("alice-mobile", bot.id, "Alice speaks from her phone.");
            relay.deliver("bob-mobile", bot.id, "Bob speaks from his phone.");
            await vi.waitFor(
                async () => {
                    const history = await alice.getMessages(bot.agent.id);
                    const messages = history.runs.flatMap((run) => run.messages);
                    for (const [index, text] of [
                        "Alice speaks from her phone.",
                        "Bob speaks from his phone.",
                    ].entries()) {
                        const message = messages.find((message) =>
                            JSON.stringify(message.content).includes(text),
                        );
                        expect(message?.metadata.userId).toBe(owners[index]);
                    }
                },
                { timeout: 10_000 },
            );
            const identities = new Map(relay.machines);
            await runtime!.close();
            runtime = undefined;
            ({ alice, bob } = await start());
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration.status).toBe(
                        "connected",
                    );
                    expect((await bob.getHappyIntegration()).integration.status).toBe("connected");
                    expect(relay.activeMachines()).toEqual(["alice-mobile", "bob-mobile"]);
                },
                { timeout: 10_000 },
            );
            expect(relay.machines).toEqual(identities);
            expect(
                [...relay.sessions.values()].filter((session) => session.botId === bot.id),
            ).toHaveLength(2);
            relay.rejected.add("alice-mobile");
            await runtime!.close();
            runtime = undefined;
            ({ alice, bob } = await start());
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration).toMatchObject({
                        status: "failed",
                        configured: false,
                        error: { code: "credentials_rejected" },
                    });
                    expect((await bob.getHappyIntegration()).integration.status).toBe("connected");
                    expect(relay.activeMachines()).toEqual(["bob-mobile"]);
                },
                { timeout: 10_000 },
            );
            const bobBefore = (await bob.getHappyIntegration()).integration;
            await alice.disconnectHappyIntegration();
            expect((await bob.getHappyIntegration()).integration).toEqual(bobBefore);
            await vi.waitFor(() => expect(relay.activeMachines()).toEqual(["bob-mobile"]));
            relay.deliver("bob-mobile", bot.id, "Bob is still connected.");
            await vi.waitFor(
                async () =>
                    expect(JSON.stringify(await bob.getMessages(bot.agent.id))).toContain(
                        "Bob is still connected.",
                    ),
                { timeout: 10_000 },
            );
            expect(await readFile(join(happyHome, "access.key"), "utf8")).toBe(external);
        } finally {
            await runtime?.close();
            for (const server of servers) {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
            await relay.close();
            vi.unstubAllGlobals();
            await rm(root, { recursive: true, force: true });
        }
    }, 30_000);
});
