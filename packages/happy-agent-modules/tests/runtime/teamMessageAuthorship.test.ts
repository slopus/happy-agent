import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient, type MessageMode } from "@slopus/happy-agent-client";
import type { SessionEvent } from "@slopus/happy-providers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
const organizationId = "org_test123";
const mode: MessageMode = {
    providerId: "gym",
    modelId: "gym/model",
    effort: "medium",
    serviceTier: null,
    permissionMode: "full_access",
};
let runtime: HappyAgentRuntime | undefined;
let server: Server | undefined;
let root: string | undefined;
let release: (() => void) | undefined;

async function stop(): Promise<void> {
    release?.();
    if (server !== undefined) {
        const closing = server;
        server = undefined;
        closing.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            closing.close((error) => (error ? reject(error) : resolve())),
        );
    }
    await runtime?.close();
    runtime = undefined;
}

afterEach(async () => {
    await stop();
    vi.unstubAllGlobals();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
    release = undefined;
});

describe("team authorship across the real runtime and HTTP API", () => {
    it("retains authenticated authors across pending, steering, retries, context, and restart", async () => {
        root = await mkdtemp(join(tmpdir(), "happy-team-authorship-"));
        const happyHome = join(root, ".happy");
        const workspace = join(root, "workspace");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "happy.toml",
        );
        await mkdir(dirname(configPath), { recursive: true });
        await mkdir(workspace);
        await writeFile(
            configPath,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                `workos_organization_id = "${organizationId}"`,
                'owner_workos_user_id = "user_alice123"',
            ].join("\n"),
        );

        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            alg: "RS256",
            kid: "authorship-test",
            use: "sig",
        };
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
            String(input).includes("api.workos.com/sso/jwks/")
                ? Response.json({ keys: [jwk] })
                : nativeFetch(input, init),
        );
        const token = async (subject: string, org = organizationId) =>
            new SignJWT({
                client_id: clientId,
                org_id: org,
                sid: "session_authorship",
            })
                .setProtectedHeader({ alg: "RS256", kid: "authorship-test" })
                .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey);
        const aliceToken = await token("user_alice123");
        const bobToken = await token("user_bob456");
        const done: SessionEvent[] = [
            { type: "text_start" },
            { type: "text_delta", delta: "Done." },
            { type: "text_end" },
            { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
        ];
        let started!: () => void;
        const began = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const provider = new ScriptedProvider([
            async function* () {
                started();
                await gate;
                yield* done;
            },
            done,
            done,
            done,
        ]);
        const start = async () => {
            const providers = new AgentProviders();
            providers.add("gym", provider, "codex");
            let endpoint = "";
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
                    server = createServer((request, response) => {
                        void prepared.api.handleRequest(
                            prepared.context("test.http"),
                            request,
                            response,
                        );
                    });
                    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
                    const address = server.address();
                    if (address === null || typeof address === "string")
                        throw new Error("No test HTTP address.");
                    endpoint = `http://127.0.0.1:${address.port}`;
                },
            });
            return {
                endpoint,
                alice: new HappyAgentClient({ endpoint, token: aliceToken }),
                bob: new HappyAgentClient({ endpoint, token: bobToken }),
            };
        };
        let clients = await start();
        const newcomer = new HappyAgentClient({
            endpoint: clients.endpoint,
            token: await token("user_new123"),
        });
        const outsider = new HappyAgentClient({
            endpoint: clients.endpoint,
            token: await token("user_out123", "org_other"),
        });
        await expect(newcomer.getUsers([])).rejects.toMatchObject({ status: 401 });
        await expect(outsider.getUsers([])).rejects.toMatchObject({ status: 401 });
        const onboard = async (client: HappyAgentClient, name: string) => {
            const empty = await client.getProfile();
            expect(empty.profile.userId).toBeNull();
            const saved = await client.updateProfile(
                { name, email: `${name.toLowerCase()}@example.test` },
                { ifMatch: empty.profile.version },
            );
            expect(saved.profile.userId).toMatch(/^[a-z][a-z0-9]+$/);
            expect((await client.getProfile()).profile).toEqual(saved.profile);
            expect((await client.getDesktopBootstrap()).profile).toEqual(saved.profile);
            await expect(
                client.updateProfile({ name: "Stale profile" }, { ifMatch: empty.profile.version }),
            ).rejects.toMatchObject({ status: 409, body: { profile: saved.profile } });
            return saved.profile.userId;
        };
        const aliceProfileId = await onboard(clients.alice, "Alice");
        const bobProfileId = await onboard(clients.bob, "Bob");
        expect(bobProfileId).not.toBe(aliceProfileId);
        const { project } = await clients.alice.registerProject({ path: workspace });
        const { agent } = await clients.alice.createAgent({
            workspaceId: project.id,
            title: "Authorship",
        });
        const first = await clients.alice.sendMessage(agent.id, {
            id: "alicefirst123",
            text: "Alice's original text",
            mode,
        });
        await began;
        const aliceId = first.message.metadata.userId;
        expect(aliceId).toBe(aliceProfileId);
        expect(aliceId).toMatch(/^[a-z][a-z0-9]+$/);
        const queued = await clients.bob.sendMessage(agent.id, {
            id: "bobqueued123",
            text: "Bob's original text",
            mode,
            delivery: "queue",
            clientMetadata: { userId: aliceId! },
        });
        const bobId = queued.message.metadata.userId;
        expect(bobId).toBe(bobProfileId);
        expect(bobId).toMatch(/^[a-z][a-z0-9]+$/);
        expect(bobId).not.toBe(aliceId);
        expect(queued.message).toMatchObject({
            status: "pending",
            clientMetadata: { userId: aliceId },
        });
        expect((await clients.alice.getAgentBootstrap(agent.id)).pending).toContainEqual(
            queued.message,
        );
        // These all wait behind the first inference and must be announced in consumption order,
        // not as the most recently authenticated caller or as one sender for the entire batch.
        await clients.bob.sendMessage(agent.id, { text: "Bob again", mode, delivery: "queue" });
        await clients.alice.sendMessage(agent.id, {
            text: "Alice returns",
            mode,
            delivery: "queue",
        });
        await clients.bob.sendMessage(agent.id, { text: "Bob returns", mode, delivery: "queue" });
        const retry = await clients.alice.sendMessage(agent.id, {
            id: queued.message.id,
            text: "Do not replace this text or author",
            mode,
        });
        expect(retry.message).toEqual(queued.message);
        const created = (await clients.alice.getEvents()).events.find(
            (event) =>
                event.type === "message.created" && event.payload.message.id === queued.message.id,
        );
        expect(created).toMatchObject({ payload: { message: { metadata: { userId: bobId } } } });

        for (const ids of ["user_invalid", Array(101).fill(aliceId).join(","), `${aliceId},`]) {
            const response = await fetch(
                `${clients.endpoint}/v0/users?ids=${encodeURIComponent(ids)}`,
                {
                    headers: { authorization: `Bearer ${aliceToken}` },
                },
            );
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ code: "invalid_request" });
        }
        const repeated = await fetch(`${clients.endpoint}/v0/users?ids=${aliceId}&ids=${bobId}`, {
            headers: { authorization: `Bearer ${aliceToken}` },
        });
        expect(repeated.status).toBe(400);
        const spoof = await fetch(`${clients.endpoint}/v0/agents/${agent.id}/send`, {
            method: "POST",
            headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
            body: JSON.stringify({ text: "spoof", mode, metadata: { userId: bobId } }),
        });
        expect(spoof.status).toBe(400);
        await expect(clients.alice.getUsers([])).resolves.toEqual({ users: [] });
        const lookup = await clients.bob.getUsers([bobId!, "unknown123", aliceId!, bobId!]);
        expect(lookup.users.map(({ id, name }) => ({ id, name }))).toEqual([
            { id: bobId, name: "Bob" },
            { id: aliceId, name: "Alice" },
        ]);
        expect(Object.keys(lookup.users[0]!).sort()).toEqual([
            "id",
            "name",
            "photo",
            "updatedAt",
            "version",
        ]);

        // A graceful stop drains current work but preserves the queued author for restoration.
        await stop();
        clients = await start();
        await vi.waitFor(
            async () => {
                const history = await clients.alice.getMessages(agent.id);
                expect((await clients.alice.getAgentBootstrap(agent.id)).pending).toEqual([]);
                expect(
                    history.runs
                        .flatMap((run) => run.messages)
                        .find((message) => message.id === queued.message.id),
                ).toMatchObject({
                    metadata: { userId: bobId },
                    content: [{ type: "text", text: "Bob's original text" }],
                });
                expect(history.runs.every((run) => run.status !== "running")).toBe(true);
            },
            { timeout: 10_000 },
        );
        const steering = await clients.bob.sendMessage(agent.id, {
            id: "bobsteer123",
            text: "Bob steers",
            mode,
            delivery: "steer",
        });
        expect(steering.message).toMatchObject({ metadata: { userId: bobId }, delivery: "steer" });
        await vi.waitFor(
            async () => {
                const history = await clients.alice.getMessages(agent.id);
                expect(
                    history.runs
                        .flatMap((run) => run.messages)
                        .find((message) => message.id === steering.message.id),
                ).toMatchObject({ metadata: { userId: bobId }, status: "accepted" });
                expect(history.runs.every((run) => run.status !== "running")).toBe(true);
            },
            { timeout: 10_000 },
        );
        await stop();
        clients = await start();
        const acceptedRetry = await clients.alice.sendMessage(agent.id, {
            id: queued.message.id,
            text: "retry after restart",
            mode,
        });
        expect(acceptedRetry.message).toMatchObject({
            metadata: { userId: bobId },
            status: "accepted",
        });
        const records = await runtime!.storage.persistence(agent.id).load(runtime!.ctx);
        expect(records).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: first.message.id,
                    type: "user",
                    metadata: expect.objectContaining({ userId: aliceId }),
                }),
                expect.objectContaining({
                    id: queued.message.id,
                    type: "user",
                    metadata: expect.objectContaining({ userId: bobId }),
                }),
                expect.objectContaining({
                    id: steering.message.id,
                    type: "user",
                    metadata: expect.objectContaining({ userId: bobId }),
                }),
            ]),
        );
        const inferenceText = provider.sessions
            .flatMap((session) => session.requests)
            .flatMap((request) =>
                request.context.messages.filter((message) => message.role === "user"),
            );
        expect(inferenceText).toContainEqual({
            role: "user",
            content: [{ type: "text", text: "Bob's original text" }],
        });
        const notices = records.flatMap((record) =>
            record.type === "system"
                ? record.message.content.flatMap((block) =>
                      block.type === "text" && block.text.startsWith("# Team sender profile")
                          ? [block.text]
                          : [],
                  )
                : [],
        );
        expect(notices).toHaveLength(4);
        for (const [index, name] of ["Alice", "Bob", "Alice", "Bob"].entries()) {
            expect(notices[index]).toContain(`Name: "${name}"`);
            expect(notices[index]).toContain(`Email: "${name.toLowerCase()}@example.test"`);
            expect(notices[index]).toContain(name === "Alice" ? aliceId! : bobId!);
            expect(notices[index]).not.toContain("user_alice123");
            expect(notices[index]).not.toContain("user_bob456");
        }
        const delivered = provider.sessions
            .flatMap((session) => session.requests)
            .at(-1)!
            .context.messages.filter(
                (message) =>
                    message.role === "user" ||
                    (message.role === "system" &&
                        message.content.some(
                            (block) =>
                                block.type === "text" &&
                                block.text.startsWith("# Team sender profile"),
                        )),
            );
        expect(delivered).toEqual([
            { role: "system", content: [{ type: "text", text: notices[0] }] },
            { role: "user", content: [{ type: "text", text: "Alice's original text" }] },
            { role: "system", content: [{ type: "text", text: notices[1] }] },
            { role: "user", content: [{ type: "text", text: "Bob's original text" }] },
            { role: "user", content: [{ type: "text", text: "Bob again" }] },
            { role: "system", content: [{ type: "text", text: notices[2] }] },
            { role: "user", content: [{ type: "text", text: "Alice returns" }] },
            { role: "system", content: [{ type: "text", text: notices[3] }] },
            { role: "user", content: [{ type: "text", text: "Bob returns" }] },
            { role: "user", content: [{ type: "text", text: "Bob steers" }] },
        ]);
        const current = await clients.bob.getProfile();
        expect(current.profile.userId).toBe(bobProfileId);
        expect((await clients.bob.getDesktopBootstrap()).profile).toEqual(current.profile);
        expect((await clients.alice.getDesktopBootstrap()).profile.userId).toBe(aliceProfileId);
        const spoofedProfile = await fetch(`${clients.endpoint}/v0/profile`, {
            method: "PATCH",
            headers: {
                authorization: `Bearer ${bobToken}`,
                "content-type": "application/json",
                "if-match": current.profile.version,
            },
            body: JSON.stringify({ userId: aliceProfileId }),
        });
        expect(spoofedProfile.status).toBe(400);
        expect((await clients.bob.getProfile()).profile).toEqual(current.profile);
        await clients.bob.updateProfile({ name: "Robert" }, { ifMatch: current.profile.version });
        const renamed = await clients.bob.getProfile();
        expect(renamed.profile.userId).toBe(bobProfileId);
        const photo = await clients.bob.setProfilePhoto(
            {
                contentType: "image/png",
                data: Uint8Array.from(
                    Buffer.from(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        "base64",
                    ),
                ),
            },
            { ifMatch: renamed.profile.version },
        );
        expect(photo.profile.userId).toBe(bobProfileId);
        expect((await clients.bob.getDesktopBootstrap()).profile).toEqual(photo.profile);
        await expect(
            clients.bob.deleteProfilePhoto({ ifMatch: renamed.profile.version }),
        ).rejects.toMatchObject({ status: 409, body: { profile: photo.profile } });
        const removed = await clients.bob.deleteProfilePhoto({ ifMatch: photo.profile.version });
        expect(removed.profile).toMatchObject({ userId: bobProfileId, photo: null });
        expect((await clients.alice.getUsers([bobId!])).users[0]).toMatchObject({
            id: bobId,
            name: "Robert",
        });
        await clients.bob.sendMessage(agent.id, {
            id: "robert123",
            text: "My profile changed",
            mode,
        });
        await vi.waitFor(
            async () => {
                const history = await clients.bob.getMessages(agent.id);
                expect(
                    history.runs
                        .flatMap((run) => run.messages)
                        .some(
                            (message) =>
                                message.role === "user" &&
                                message.id === "robert123" &&
                                message.status === "accepted",
                        ),
                ).toBe(true);
                expect(history.runs.every((run) => run.status !== "running")).toBe(true);
            },
            { timeout: 10_000 },
        );
        const renamedContext = provider.sessions.flatMap((session) => session.requests).at(-1)!
            .context.messages;
        expect(renamedContext.at(-2)).toMatchObject({
            role: "system",
            content: [{ type: "text", text: expect.stringContaining('Name: "Robert"') }],
        });
        expect(renamedContext.at(-1)).toEqual({
            role: "user",
            content: [{ type: "text", text: "My profile changed" }],
        });
        expect(JSON.stringify((await clients.bob.getMessages(agent.id)).runs)).not.toContain(
            "# Team sender profile",
        );
        expect(
            (await clients.alice.getMessages(agent.id)).runs
                .flatMap((run) => run.messages)
                .filter((message) => message.role !== "user")
                .every((message) => message.metadata.userId === undefined),
        ).toBe(true);
    }, 40_000);
});
