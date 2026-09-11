import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

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
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
});

it("isolates team drafts, timestamps, bootstrap, event pulls and streams, and restart without wire changes", async () => {
    root = await mkdtemp(join(tmpdir(), "team-drafts-"));
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
            'workos_organization_id = "org_drafts"',
            'owner_workos_user_id = "user_alice"',
        ].join("\n"),
    );
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "drafts", use: "sig" };
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes("api.workos.com/sso/jwks/")
            ? Promise.resolve(Response.json({ keys: [jwk] }))
            : nativeFetch(input, init),
    );
    const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
    const token = (subject: string) =>
        new SignJWT({ client_id: clientId, org_id: "org_drafts", sid: "session_drafts" })
            .setProtectedHeader({ alg: "RS256", kid: "drafts" })
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
                if (!address || typeof address === "string")
                    throw new Error("Missing fixture address.");
                endpoint = `http://127.0.0.1:${address.port}`;
            },
        });
        return {
            alice: new HappyAgentClient({ endpoint, token: aliceToken }),
            aliceDevice: new HappyAgentClient({ endpoint, token: aliceToken }),
            bob: new HappyAgentClient({ endpoint, token: bobToken }),
        };
    };
    let { alice, aliceDevice, bob } = await start();
    for (const [client, name] of [
        [alice, "Alice"],
        [bob, "Bob"],
    ] as const) {
        const { profile } = await client.getProfile();
        await client.updateProfile({ name }, { ifMatch: profile.version });
    }
    const { project } = await alice.registerProject({ path: workspace });
    const { agent } = await alice.createAgent({ workspaceId: project.id, title: "Private drafts" });
    const draft = (text: string) => ({
        text,
        providerId: "gym",
        modelId: "gym/model",
        effort: "medium",
        serviceTier: null,
        permissionMode: "full_access" as const,
    });
    const before = await alice.getAgentBootstrap(agent.id);
    const aliceSaved = await alice.saveAgentDraft(agent.id, {
        draft: draft("Alice private"),
        updatedAt: 200,
        mutationId: "alicewrite",
    });
    expect(await bob.getAgentDraft(agent.id)).toEqual({ draft: { value: null, updatedAt: null } });
    expect(await aliceDevice.getAgentDraft(agent.id)).toEqual(aliceSaved);
    const bobSaved = await bob.saveAgentDraft(agent.id, {
        draft: draft("Bob private"),
        updatedAt: 100,
    });
    expect(bobSaved.draft.value?.text).toBe("Bob private");
    expect((await alice.getAgentBootstrap(agent.id)).draft).toEqual(aliceSaved.draft);
    expect((await bob.getAgentBootstrap(agent.id)).draft).toEqual(bobSaved.draft);
    const bobPage = await bob.getEvents({ after: before.cursor });
    expect(
        bobPage.events
            .filter((event) => event.type === "agent.draft.updated")
            .map((event) => event.payload),
    ).toEqual([{ agentId: agent.id, draft: bobSaved.draft }]);
    expect(JSON.stringify(bobPage)).not.toContain("Alice private");
    const alicePage = await alice.getEvents({ after: before.cursor });
    expect(
        alicePage.events
            .filter((event) => event.type === "agent.draft.updated")
            .map((event) => event.payload),
    ).toEqual([{ agentId: agent.id, draft: aliceSaved.draft, mutationId: "alicewrite" }]);
    const abort = new AbortController();
    const frames = alice.streamEvents({
        after: before.cursor,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
    });
    const nextDraft = async () => {
        for (let count = 0; count < 100; count++) {
            const { value, done } = await frames.next();
            if (done) throw new Error("Draft stream ended.");
            if (value.kind === "event" && value.event.type === "agent.draft.updated")
                return value.event.payload;
        }
        throw new Error("Missing draft event.");
    };
    try {
        expect((await frames.next()).value?.kind).toBe("hello");
        expect(await nextDraft()).toEqual({
            agentId: agent.id,
            draft: aliceSaved.draft,
            mutationId: "alicewrite",
        });
        await bob.saveAgentDraft(agent.id, { draft: draft("Bob live"), updatedAt: 101 });
        const cleared = await aliceDevice.saveAgentDraft(agent.id, { draft: null, updatedAt: 300 });
        expect(await nextDraft()).toEqual({ agentId: agent.id, draft: cleared.draft });
        const afterClear = (await alice.getEvents()).latestCursor;
        expect(
            await alice.saveAgentDraft(agent.id, { draft: draft("Stale"), updatedAt: 299 }),
        ).toEqual(cleared);
        expect(
            (await alice.getEvents({ after: afterClear })).events.filter(
                (event) => event.type === "agent.draft.updated",
            ),
        ).toEqual([]);
    } finally {
        abort.abort();
        await frames.return(undefined);
    }
    const beforeHidden = (await alice.getEvents()).latestCursor;
    await bob.saveAgentDraft(agent.id, { draft: draft("Bob durable"), updatedAt: 102 });
    const hidden = await alice.getEvents({ after: beforeHidden, limit: 1 });
    expect(hidden.events).toEqual([]);
    expect(hidden.cursor).not.toBe(beforeHidden);
    await Promise.all([
        alice.saveAgentDraft(agent.id, { draft: draft("Alice older"), updatedAt: 400 }),
        aliceDevice.saveAgentDraft(agent.id, { draft: draft("Alice newest"), updatedAt: 500 }),
    ]);
    expect((await alice.getAgentDraft(agent.id)).draft.value?.text).toBe("Alice newest");
    await alice.saveAgentDraft(agent.id, { draft: null, updatedAt: 600 });
    await stop();
    ({ alice, aliceDevice, bob } = await start());
    expect((await alice.getAgentDraft(agent.id)).draft).toEqual({ value: null, updatedAt: 600 });
    expect((await bob.getAgentDraft(agent.id)).draft).toEqual({
        value: draft("Bob durable"),
        updatedAt: 102,
    });
    expect(
        (await aliceDevice.saveAgentDraft(agent.id, { draft: draft("Old device"), updatedAt: 500 }))
            .draft.value,
    ).toBeNull();
}, 30_000);
