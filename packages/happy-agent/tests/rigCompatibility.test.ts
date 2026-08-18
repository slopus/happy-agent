import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
    listFoldersResponseSchema,
    listPluginsResponseSchema,
    listWorkletsResponseSchema,
    onboardingStatusSchema,
    p2pStatusSchema,
    happyCloudStatusSchema,
} from "../../rig-connect/sources/protocol.js";
import { ProtocolHttpClient } from "../../rig/sources/client/ProtocolHttpClient.js";
import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
} from "../sources/index.js";
import { createCompatibilitySnapshots } from "../sources/modules/http/compatibilityRoutes.js";

/** Every request names the account, the model, the effort and the tier: the agent assumes nothing. */
const SELECTION = {
    effort: "medium",
    modelId: "scripted-model",
    providerId: "scripted",
    serviceTier: null,
} as const;

const running = new Set<{
    readonly daemon: HappyAgentDaemon;
    readonly directory: string;
}>();

afterEach(async () => {
    await Promise.all(
        [...running].map(async ({ daemon, directory }) => {
            await daemon.close().catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("Happy Agent Rig compatibility", () => {
    it("keeps every empty compatibility snapshot valid against rig-connect", () => {
        const snapshots = createCompatibilitySnapshots("cursor-1");

        expect(Value.Check(listFoldersResponseSchema, snapshots.folders)).toBe(true);
        expect(Value.Check(listPluginsResponseSchema, snapshots.plugins)).toBe(true);
        expect(Value.Check(listWorkletsResponseSchema, snapshots.worklets)).toBe(true);
        expect(Value.Check(p2pStatusSchema, snapshots.p2p)).toBe(true);
        expect(Value.Check(onboardingStatusSchema, snapshots.onboarding)).toBe(true);
        expect(Value.Check(happyCloudStatusSchema, snapshots.happyCloud)).toBe(true);
    });

    it("loads a chat and optional empty collections through the unchanged Rig client", async () => {
        const fixture = await startTestDaemon();
        const connection = await connectTestDaemon(fixture.daemon);

        await expect(connection.client.health()).resolves.toMatchObject({
            healthy: true,
            protocolVersion: 17,
            ready: true,
        });
        await expect(connection.client.catalog()).resolves.toMatchObject({
            folderItems: [],
            folders: [],
            projects: [],
            protocolVersion: 17,
            sessions: [expect.objectContaining({ scope: { kind: "unsorted" } })],
            sessionsComplete: true,
            workspaces: [],
        });
        const sessions = await connection.client.listSessions();
        const session = sessions.sessions[0];
        expect(session).toMatchObject({
            modelId: "scripted-model",
            permissionMode: "auto",
            providerId: "scripted",
            scope: { kind: "unsorted" },
        });
        if (session === undefined) throw new Error("Happy Agent exposed no root chat.");

        await expect(
            connection.client.getSession(session.id, { messageLimit: 20 }),
        ).resolves.toMatchObject({
            session: {
                agent: {
                    depth: 0,
                    rootSessionId: session.id,
                    type: "primary",
                },
                id: session.id,
                mcpServers: [],
                modelCatalog: {
                    defaultModelId: "scripted-model",
                    defaultProviderId: "scripted",
                },
                pendingUserInputs: [],
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
                snapshot: { messages: [] },
                subagents: [],
                tasks: [],
                workflows: [],
                workflowsEnabled: true,
            },
        });
        await expect(connection.client.listFolders()).resolves.toEqual({
            folders: [],
            items: [],
            revision: 0,
        });
        await expect(connection.client.getP2pStatus()).resolves.toEqual({
            name: "Happy Agent",
            transports: [],
        });
        await expect(connection.client.getHappyCloudStatus()).resolves.toMatchObject({
            authority: "local_record_only",
            enrollment: { state: "not_enrolled" },
            profile: { state: "not_created" },
        });
        await expect(connection.client.listProviderUsage()).resolves.toEqual({
            providers: [
                {
                    checkedAt: expect.any(Number),
                    error: null,
                    providerId: "scripted",
                    tokens: { inferences: 0, input: 0, output: 0, total: 0, turns: 0 },
                    usage: null,
                },
            ],
        });
        await expect(connection.client.listSecrets()).resolves.toEqual({ secrets: [] });
        await expect(connection.client.listPendingExternalToolCalls()).resolves.toEqual({
            calls: [],
        });
        await expect(connection.client.listExternalToolCalls(session.id)).resolves.toEqual({
            calls: [],
        });
        await expect(connection.client.listSubagents(session.id)).resolves.toEqual({
            subagents: [],
        });
        await expect(connection.client.getCurrentProviderQuota(session.id)).resolves.toEqual({
            currentProviderId: "scripted",
        });
        await expect(connection.client.getSessionUsage(session.id)).resolves.toMatchObject({
            currentProviderId: "scripted",
            groups: expect.any(Array),
            quotas: [],
            sessionTokenCount: {
                lastContextTokens: expect.any(Number),
                totalTokens: expect.any(Number),
            },
        });
        await expect(connection.client.getEvents(session.id)).resolves.toMatchObject({
            events: expect.any(Array),
        });
        await expect(connection.client.getPresence()).resolves.toMatchObject({
            presence: {
                presence: { id: "online" },
                presences: expect.arrayContaining([expect.objectContaining({ id: "online" })]),
            },
        });
        const terminal = await connection.client.connectSessionTerminal(session.id, {
            focused: true,
        });
        await terminal.close();

        const state = await requestJson(
            connection.socketPath,
            connection.token,
            `/v0/sessions/${session.id}/state`,
        );
        expect(state).toMatchObject({
            cursor: expect.any(String),
            resumed: false,
            session: {
                id: session.id,
                snapshot: { messages: [] },
            },
            transcript: {
                complete: true,
                messages: [],
                turns: expect.any(Array),
            },
        });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/plugins"),
        ).resolves.toMatchObject({ failures: [], plugins: [], version: "empty" });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/worklets"),
        ).resolves.toEqual({ version: "empty", worklets: [] });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/profiles"),
        ).resolves.toEqual({ profiles: [] });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/onboarding"),
        ).resolves.toEqual({ onboardingVersion: 2, state: "complete" });
        // Sharing is a real capability now, and it is off unless the configuration turns it on.
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/sharing"),
        ).rejects.toThrow(/503.*Sharing is unavailable\./u);

        const stateCursor = (state as { readonly cursor?: unknown }).cursor;
        if (typeof stateCursor !== "string") {
            throw new Error("Happy Agent exposed an invalid session state cursor.");
        }
        const streamController = new AbortController();
        let resolveAgentMessage!: () => void;
        const observedAgentMessage = new Promise<void>((resolve) => {
            resolveAgentMessage = resolve;
        });
        const watching = connection.client.watchSessionEvents({
            after: stateCursor,
            onEvent: (event) => {
                if (event.type === "agent_message") resolveAgentMessage();
            },
            sessionId: session.id,
            signal: streamController.signal,
        });
        await expect(
            connection.client.submitMessage(session.id, {
                ...SELECTION,
                await: true,
                text: "Hello from Rig.",
            }),
        ).resolves.toMatchObject({
            eventId: expect.any(String),
            runId: expect.any(String),
            sessionId: session.id,
        });
        await observedAgentMessage;
        streamController.abort();
        await watching;
        await expect
            .poll(
                async () =>
                    (await connection.client.getSession(session.id)).session.snapshot.messages
                        .length,
                { timeout: 5_000 },
            )
            .toBe(2);
        await expect(connection.client.getSession(session.id)).resolves.toMatchObject({
            session: {
                snapshot: {
                    messages: [
                        { role: "user" },
                        {
                            blocks: [{ text: "Happy Agent replied.", type: "text" }],
                            role: "agent",
                        },
                    ],
                },
            },
        });
        expect(fixture.unexpectedErrors).toEqual([]);
    });

    it("backs presence, secrets, and session processes with live daemon modules", async () => {
        const fixture = await startTestDaemon();
        const connection = await connectTestDaemon(fixture.daemon);

        const until = Date.now() + 60_000;
        await expect(
            connection.client.setPresence({
                fallbackPresenceId: "online",
                presenceId: "away",
                until,
            }),
        ).resolves.toMatchObject({
            presence: {
                changesAt: until,
                fallbackPresenceId: "online",
                presence: { id: "away", title: "Away" },
            },
        });
        await expect(connection.client.getPresence()).resolves.toMatchObject({
            presence: {
                changesAt: until,
                fallbackPresenceId: "online",
                presence: { id: "away" },
            },
        });

        const registered = await connection.client.registerSecret({
            description: "Compatibility credentials",
            environment: {
                KEEP: "not-in-the-response",
                ROTATE: "also-not-in-the-response",
            },
            id: "compatibility-secret",
        });
        expect(registered).toEqual({
            secret: {
                description: "Compatibility credentials",
                environmentVariables: ["KEEP", "ROTATE"],
                id: "compatibility-secret",
            },
        });
        expect(JSON.stringify(registered)).not.toContain("not-in-the-response");
        expect(JSON.stringify(registered)).not.toContain("also-not-in-the-response");
        expect(Object.hasOwn(registered.secret, "revision")).toBe(false);
        await expect(connection.client.listSecrets()).resolves.toEqual({
            secrets: [registered.secret],
        });
        await expect(
            connection.client.updateSecret("compatibility-secret", {
                description: "Rotated compatibility credentials",
                environment: { ADDED: "not-returned-either", ROTATE: null },
            }),
        ).resolves.toEqual({
            secret: {
                description: "Rotated compatibility credentials",
                environmentVariables: ["ADDED", "KEEP"],
                id: "compatibility-secret",
            },
        });
        await expect(connection.client.unregisterSecret("compatibility-secret")).resolves.toEqual({
            removed: true,
        });
        await expect(connection.client.unregisterSecret("compatibility-secret")).resolves.toEqual({
            removed: false,
        });

        const created = await connection.client.createSession({
            ...SELECTION,
            cwd: fixture.directory,
            permissionMode: "full_access",
        });
        const started = await connection.client.runShellCommand(created.session.id, {
            command: "sleep 60",
            commandId: "compatibility-shell",
        });
        expect(started).toMatchObject({
            command: "sleep 60",
            commandId: "compatibility-shell",
            status: "running",
        });
        if (started.status !== "running") throw new Error("Expected a running shell command.");
        await expect(
            connection.client.readBackgroundProcess(created.session.id, started.sessionId),
        ).resolves.toMatchObject({
            command: "sleep 60",
            sessionId: started.sessionId,
            status: "running",
        });
        await expect(
            connection.client.stopBackgroundProcess(created.session.id, started.sessionId),
        ).resolves.toMatchObject({
            process: { sessionId: started.sessionId, status: "killed" },
            stopped: true,
        });
        const first = await connection.client.runShellCommand(created.session.id, {
            command: "sleep 60",
            commandId: "compatibility-shell-first",
        });
        const second = await connection.client.runShellCommand(created.session.id, {
            command: "sleep 60",
            commandId: "compatibility-shell-second",
        });
        if (first.status !== "running" || second.status !== "running") {
            throw new Error("Expected two running shell commands.");
        }
        await expect(
            connection.client.stopBackgroundProcesses(created.session.id),
        ).resolves.toEqual({ stoppedProcesses: 2 });
        await expect(
            connection.client.readBackgroundProcess(created.session.id, first.sessionId),
        ).resolves.toMatchObject({ status: "killed" });
        await expect(
            connection.client.readBackgroundProcess(created.session.id, second.sessionId),
        ).resolves.toMatchObject({ status: "killed" });

        expect(fixture.unexpectedErrors).toEqual([]);
    });

    it("persists message-carried selection and emits configuration events", async () => {
        const fixture = await startTestDaemon();
        const connection = await connectTestDaemon(fixture.daemon);

        const messageSession = (
            await connection.client.createSession({
                ...SELECTION,
                cwd: fixture.directory,
            })
        ).session;
        await connection.client.submitMessage(messageSession.id, {
            ...SELECTION,
            await: true,
            debug: true,
            interactive: false,
            modelId: "scripted-model-2",
            mutationId: "message-model",
            permissionMode: "read_only",
            text: "Use the second model.",
        });
        await expect(connection.client.getSession(messageSession.id)).resolves.toMatchObject({
            session: {
                modelId: "scripted-model-2",
                permissionMode: "read_only",
                providerId: "scripted",
            },
        });
        await expect(connection.client.getEvents(messageSession.id)).resolves.toMatchObject({
            events: expect.arrayContaining([
                expect.objectContaining({
                    data: expect.objectContaining({
                        changed: ["model"],
                        modelId: "scripted-model-2",
                        mutationId: "message-model",
                        providerId: "scripted",
                    }),
                    type: "session_configuration_changed",
                }),
                expect.objectContaining({
                    data: expect.objectContaining({
                        mutationId: "message-model",
                        permissionMode: "read_only",
                    }),
                    type: "permission_mode_changed",
                }),
            ]),
        });

        await connection.client.submitMessage(messageSession.id, {
            ...SELECTION,
            await: true,
            modelId: "scripted-model-2",
            text: "Keep using it.",
        });
        await expect
            .poll(() => fixture.modelRuns.slice(-2), { timeout: 5_000 })
            .toEqual(["scripted-model-2", "scripted-model-2"]);
        expect(fixture.unexpectedErrors).toEqual([]);
    });
});

async function startTestDaemon() {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "ha-"));
    const providers = new AgentProviders();
    const modelRuns: string[] = [];
    providers.add(
        "scripted",
        (selection) =>
            scriptedProvider((sessionId) => {
                // Naming a chat is a side question asked on a session of its own, on whichever
                // model is cheapest. What this records is what the conversation itself ran on.
                if (sessionId.startsWith("naming:")) return;
                modelRuns.push(selection.model ?? "");
            }),
        "gym",
    );
    const models: readonly AgentModel[] = [
        {
            defaultEffort: "medium",
            effortLevels: ["low", "medium", "high"],
            id: "scripted-model",
            name: "Scripted Model",
            providerId: "scripted",
        },
        {
            defaultEffort: "medium",
            effortLevels: ["low", "medium", "high"],
            id: "scripted-model-2",
            name: "Scripted Model 2",
            providerId: "scripted",
        },
    ];
    const unexpectedErrors: unknown[] = [];
    const daemon = await startHappyAgentDaemon({
        happyHome: join(directory, ".happy"),
        httpConfiguration: {
            onUnexpectedError: (error) => {
                unexpectedErrors.push(error);
            },
            p2pName: "Happy Agent",
        },
        inference: { models, providers },
        version: "compatibility-test",
    });
    const fixture = { daemon, directory, modelRuns, unexpectedErrors };
    running.add(fixture);
    return fixture;
}

async function connectTestDaemon(daemon: HappyAgentDaemon) {
    const token = (await readFile(daemon.tokenPath, "utf8")).trim();
    return {
        client: new ProtocolHttpClient({
            pathPrefix: "/v0",
            socketPath: daemon.socketPath,
            token,
        }),
        socketPath: daemon.socketPath,
        token,
    };
}

function scriptedProvider(
    onRun: (sessionId: string) => void = () => undefined,
): Parameters<AgentProviders["add"]>[1] {
    return {
        inputTypes: ["text"],
        name: "scripted",
        outputTypes: ["text"],
        session: async (id: string) => ({
            id,
            compact: async () => {
                throw new Error("Compaction is unavailable in this test.");
            },
            destroy: () => undefined,
            run: () => {
                onRun(id);
                return (async function* () {
                    yield { type: "text_start" } as const;
                    yield { type: "text_delta", delta: "Happy Agent replied." } as const;
                    yield { type: "text_end" } as const;
                    yield {
                        type: "done",
                        state: "normal",
                    } as const;
                })();
            },
        }),
    } as never;
}

async function requestJson(socketPath: string, token: string, path: string): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                socketPath,
                path,
                method: "GET",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${token}`,
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(
                            new Error(
                                `Happy Agent answered ${String(response.statusCode)}: ${text}`,
                            ),
                        );
                        return;
                    }
                    resolve(JSON.parse(text));
                });
            },
        );
        request.on("error", reject);
        request.end();
    });
}
