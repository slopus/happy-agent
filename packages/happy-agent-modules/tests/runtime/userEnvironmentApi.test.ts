import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import type { SessionEvent } from "@slopus/happy-providers";
import { afterEach, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

let runtime: HappyAgentRuntime | undefined;
let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await runtime?.close();
    runtime = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
});

const done: SessionEvent[] = [
    { type: "text_start" },
    { type: "text_delta", delta: "Done." },
    { type: "text_end" },
    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
];

const mode = {
    providerId: "gym",
    modelId: "gym/model",
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
} as const;

async function start(provider: ScriptedProvider) {
    root = await mkdtemp(join(tmpdir(), "user-environment-api-"));
    const providers = new AgentProviders();
    providers.add("gym", provider, "codex");
    let endpoint = "";
    runtime = await startHappyAgentRuntime({
        happyHome: join(root, ".happy"),
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
                void prepared.api.handleRequest(prepared.context("test.http"), request, response);
            });
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing address.");
            endpoint = `http://127.0.0.1:${address.port}`;
        },
    });
    const token = runtime.api.token()!;
    const client = new HappyAgentClient({ endpoint, token });
    /** The new routes, called directly: the client release that wraps them is not published yet. */
    const request = async (method: string, path: string, body: unknown) => {
        const response = await fetch(`${endpoint}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
        };
    };
    return { client, request };
}

it("stores each device's report, announces it, and tells the agent through a send", async () => {
    const provider = new ScriptedProvider([done, done]);
    const { client, request } = await start(provider);
    const health = await client.getHealth();
    expect(health.capabilities).toMatchObject({ userEnvironment: true });

    const cursor = (await client.getEvents()).latestCursor;
    const reported = await request("PUT", "/v0/environment", {
        mutationId: "report-1",
        deviceId: "laptop",
        deviceKind: "desktop",
        timeZone: "europe/berlin",
        utcOffsetMinutes: 60,
        languages: ["de-de", "en-US"],
        hourCycle: "h23",
    });
    expect(reported.status).toBe(200);
    const environment = {
        deviceId: "laptop",
        deviceKind: "desktop",
        timeZone: "Europe/Berlin",
        languages: ["de-DE", "en-US"],
        hourCycle: "h23",
        updatedAt: expect.any(Number),
        reportedAt: expect.any(Number),
    };
    expect(reported.body).toEqual({ environment });
    expect(reported.body.environment).not.toHaveProperty("utcOffsetMinutes");

    // Another device keeps its own record; a report leaving fields out keeps what is stored.
    const phone = await request("PUT", "/v0/environment", {
        deviceId: "phone",
        timeZone: "America/New_York",
    });
    expect(phone.body).toEqual({
        environment: {
            deviceId: "phone",
            timeZone: "America/New_York",
            updatedAt: expect.any(Number),
            reportedAt: expect.any(Number),
        },
    });

    const events = (await client.getEvents({ after: cursor })).events.filter(
        (event) => (event.type as string) === "user_environment.updated",
    );
    expect(events.map((event) => event.payload)).toEqual([
        { environment: reported.body.environment, mutationId: "report-1" },
        { environment: phone.body.environment },
    ]);

    const agent = (await client.listBots()).bots.find((bot) => bot.isAdmin)!.agent;
    const sent = await request("POST", `/v0/agents/${agent.id}/send`, {
        text: "What time is it for me?",
        mode,
        deviceId: "laptop",
    });
    expect(sent.status).toBe(202);
    // The device stays internal: it is not public message metadata.
    expect(JSON.stringify(sent.body)).not.toContain("laptop");
    await vi.waitFor(() => expect(provider.sessions.flatMap((s) => s.requests)).toHaveLength(1), {
        timeout: 20_000,
        interval: 20,
    });
    const notices = provider.sessions
        .flatMap((session) => session.requests)[0]!
        .context.messages.flatMap((message) =>
            message.role === "system"
                ? message.content.flatMap((block) =>
                      block.type === "text" && block.text.startsWith("User environment")
                          ? [block.text]
                          : [],
                  )
                : [],
        );
    expect(notices).toEqual([
        expect.stringMatching(
            /^User environment \(computer\): time zone Europe\/Berlin \(UTC\+[12]\), language de-DE, 24-hour clock\. /,
        ),
    ]);
}, 180_000);

it("refuses a malformed report or send and stores nothing", async () => {
    const { client, request } = await start(new ScriptedProvider([]));
    const before = (await client.getEvents()).latestCursor;
    for (const body of [
        { timeZone: "Europe/Berlin" },
        { deviceId: "my laptop" },
        { deviceId: "laptop", timeZone: null },
        { deviceId: "laptop", country: "DE" },
        { deviceId: "laptop", timeZone: "Mars/Olympus" },
        { deviceId: "laptop", languages: ["??"] },
        { deviceId: "laptop", firstDayOfWeek: 8 },
        { deviceId: "laptop", calendar: "gregorian" },
    ]) {
        const refused = await request("PUT", "/v0/environment", body);
        expect(refused, JSON.stringify(body)).toMatchObject({
            status: 400,
            body: { code: "invalid_request" },
        });
    }
    const agent = (await client.listBots()).bots.find((bot) => bot.isAdmin)!.agent;
    expect(
        await request("POST", `/v0/agents/${agent.id}/send`, {
            text: "Hello",
            mode,
            deviceId: "not a device",
        }),
    ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    const page = await client.getEvents({ after: before });
    expect(
        page.events.filter((event) => (event.type as string) === "user_environment.updated"),
    ).toEqual([]);
    expect(page.events.filter((event) => event.type === "message.created")).toEqual([]);
}, 180_000);
