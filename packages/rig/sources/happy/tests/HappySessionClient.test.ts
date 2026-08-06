import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    NACL_NONCE_BYTES,
    nobleBoxKeyPairFromSecretKey,
    nobleBoxOpen,
    nobleSecretBoxSeal,
} from "../../crypto/nobleNaCl.js";
import { createSessionDatabaseFixture } from "../../persistence/database/tests/createSessionDatabaseFixture.js";
import type { AbortRunOptions } from "../../protocol/index.js";
import type { InMemorySession } from "../../session/InMemorySession.js";
import { decryptHappyPayload, encryptHappyPayload } from "../happyEncryption.js";
import { HappySessionClient } from "../HappySessionClient.js";
import { HappySyncRepository } from "../HappySyncRepository.js";
import type { HappyConnectionConfiguration, HappyRemoteMessage } from "../types.js";

const directories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("HappySessionClient", () => {
    it("creates a v3 session, flushes encrypted messages, and delivers mobile input once", async () => {
        const { databasePath, repository } = await createRepository();
        const sessionKey = new Uint8Array(32).fill(7);
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(9));
        repository.ensureSession({
            credentialFingerprint: "account",
            encryptionKey: sessionKey,
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const submitted: unknown[] = [];
        const { session } = fakeSession(submitted);
        const outbound: Array<{ content: string; localId: string }> = [];
        let servedMobileMessage = false;
        const mobilePayload = Buffer.from(
            encryptHappyPayload(sessionKey, "dataKey", {
                content: { text: "Continue from my phone.", type: "text" },
                role: "user",
            }),
        ).toString("base64");
        const socket = new FakeSocket();
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/v1/sessions")) {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                expect(body).toMatchObject({ agentState: null, tag: "rig:session-1" });
                expect(unwrapDataKey(String(body.dataEncryptionKey), account.secretKey)).toEqual(
                    sessionKey,
                );
                return Response.json({
                    session: {
                        id: "remote-1",
                        metadata: body.metadata,
                        metadataVersion: 0,
                        seq: 0,
                    },
                });
            }
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body)) as {
                    messages: Array<{ content: string; localId: string }>;
                };
                outbound.push(...body.messages);
                return Response.json({ messages: [] });
            }
            const messages: HappyRemoteMessage[] = servedMobileMessage
                ? []
                : [
                      {
                          content: { c: mobilePayload, t: "encrypted" },
                          createdAt: 1,
                          id: "mobile-1",
                          localId: "mobile-local-1",
                          seq: 1,
                          updatedAt: 1,
                      },
                  ];
            servedMobileMessage = true;
            return Response.json({ hasMore: false, messages });
        });
        const client = new HappySessionClient({
            configuration: configuration(account.publicKey),
            fetch: request,
            repository,
            session,
            socketFactory: () => socket,
        });
        client.enqueue([
            {
                content: {
                    ev: { t: "text", text: "Hello" },
                    id: "local-1",
                    role: "user",
                    time: 1,
                },
                localId: "rig:local-1",
                meta: { sentFrom: "rig" },
                role: "session",
            },
        ]);
        client.start();

        await waitFor(() => submitted.length === 1 && outbound.length === 1);

        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(outbound[0]!.content, "base64")),
        ).toMatchObject({ content: { id: "local-1" }, role: "session" });
        expect(submitted).toEqual([
            {
                clientSubmissionId: "happy:mobile-1",
                displayText: "Continue from my phone.",
                text: "Continue from my phone.",
            },
        ]);
        expect(repository.getSession("session-1")?.lastRemoteSeq).toBe(1);
        expect(socket.emitted.find(([event]) => event === "session-alive")?.[1]).toMatchObject({
            activity: { kind: "idle", label: "Idle" },
            thinking: false,
        });
        await client.close();
        repository.close();
        expect(databasePath).toBeTruthy();
    });

    it("publishes Rig identity, provider-qualified models, reasoning, and live activity", async () => {
        const { repository } = await createRepository();
        const sessionKey = new Uint8Array(32).fill(7);
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(9));
        repository.ensureSession({
            credentialFingerprint: "account",
            encryptionKey: sessionKey,
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const harness = fakeSession([]);
        const socket = new FakeSocket();
        const request = vi.fn<typeof fetch>(async (input, init) => {
            if (String(input).endsWith("/v1/sessions")) {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                const initial = decryptHappyPayload(
                    sessionKey,
                    "dataKey",
                    Buffer.from(String(body.metadata), "base64"),
                ) as any;
                expect(initial).toMatchObject({
                    capabilities: {
                        abort: true,
                        attachments: { enabled: true },
                        modelSelection: true,
                        permissionModeSelection: true,
                        reasoningSelection: true,
                        resume: false,
                    },
                    client: { id: "rig", name: "Rig" },
                    currentModelCode: "gpt-test",
                    currentModelProviderId: "codex",
                    currentOperatingModeCode: "auto",
                    models: [
                        {
                            code: "gpt-test",
                            id: "gpt-test",
                            name: "GPT Test",
                            providerId: "codex",
                            providerKind: "codex",
                            providerName: "OpenAI Codex",
                            thinkingLevels: ["low", "high"],
                        },
                        {
                            code: "claude-test",
                            id: "claude-test",
                            name: "Claude Test",
                            providerId: "claude",
                            providerKind: "claude",
                            providerName: "Anthropic Claude",
                            thinkingLevels: ["high"],
                        },
                    ],
                    provider: { id: "codex", kind: "codex", name: "OpenAI Codex" },
                    providers: [
                        { id: "codex", kind: "codex", name: "OpenAI Codex" },
                        { id: "claude", kind: "claude", name: "Anthropic Claude" },
                    ],
                    operatingModes: [
                        { code: "auto", kind: "safe-yolo", value: "Auto" },
                        {
                            code: "workspace_write",
                            kind: "default",
                            value: "Workspace write",
                        },
                        { code: "read_only", kind: "read-only", value: "Read only" },
                        { code: "full_access", kind: "yolo", value: "Full access" },
                    ],
                    permissionMode: "auto",
                });
                return Response.json({
                    session: {
                        id: "remote-1",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            return Response.json({ hasMore: false, messages: [] });
        });
        const client = new HappySessionClient({
            configuration: configuration(account.publicKey),
            fetch: request,
            getSubagents: () => [
                {
                    agentId: "agent-2",
                    createdAt: 1,
                    depth: 1,
                    description: "Working",
                    id: "subagent-1",
                    modelId: "gpt-test",
                    parentSessionId: "session-1",
                    status: "running",
                    updatedAt: 1,
                },
            ],
            modelCatalog: {
                defaultModelId: "gpt-test",
                defaultProviderId: "codex",
                models: [],
                providers: [
                    { models: harness.snapshot.models, providerId: "codex" },
                    {
                        models: [
                            {
                                defaultThinkingLevel: "high",
                                id: "claude-test",
                                name: "Claude Test",
                                thinkingLevels: ["high"],
                            },
                        ],
                        providerId: "claude",
                    },
                ],
            },
            repository,
            session: harness.session,
            socketFactory: () => socket,
        });
        client.start();
        await waitFor(() => socket.emitted.some(([event]) => event === "session-alive"));

        harness.snapshot.title = "Updated from Rig";
        Object.assign(harness.activity, {
            kind: "generating_tool_call",
            label: "Generating a tool call",
            runId: "run-1",
            since: 20,
        });
        harness.snapshot.backgroundProcesses = [
            { command: "pnpm test", cwd: "/workspace", sessionId: 4, status: "running" },
        ];
        harness.snapshot.workflows = [
            {
                agentCount: 1,
                code: "test",
                description: "Test",
                logs: [],
                name: "Tests",
                runId: "workflow-1",
                startedAt: 1,
                status: "running",
                taskId: "task-1",
            },
        ];
        client.kick();

        await waitFor(() => socket.emitted.some(([event]) => event === "update-metadata"));
        const update = socket.emitted.find(([event]) => event === "update-metadata")?.[1] as any;
        const metadata = decryptHappyPayload(
            sessionKey,
            "dataKey",
            Buffer.from(update.metadata, "base64"),
        );
        expect(metadata).toMatchObject({
            activity: {
                processes: { running: 1 },
                session: {
                    kind: "generating_tool_call",
                    runId: "run-1",
                },
                subagents: { running: 1, total: 1 },
                workflows: { running: 1, total: 1 },
            },
            name: "Updated from Rig",
            summary: { text: "Updated from Rig" },
        });

        await client.close();
        repository.close();
    });

    it("applies provider-qualified model and reasoning, decrypts attachments, and handles abort RPC", async () => {
        const { repository } = await createRepository();
        const sessionKey = new Uint8Array(32).fill(7);
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(9));
        repository.ensureSession({
            credentialFingerprint: "account",
            encryptionKey: sessionKey,
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const submitted: unknown[] = [];
        const harness = fakeSession(submitted);
        const image = new Uint8Array([1, 2, 3, 4]);
        const encryptedImage = encryptBlob(image, deriveBlobKey(sessionKey, "dataKey"));
        const filePayload = encodeRemote(sessionKey, {
            content: {
                data: {
                    ev: {
                        mimeType: "image/png",
                        name: "photo.png",
                        ref: "sessions/remote-1/attachments/photo.enc",
                        size: image.length,
                        t: "file",
                    },
                    id: "file-1",
                    role: "user",
                    time: 1,
                },
                type: "session",
            },
            role: "session",
        });
        const textPayload = encodeRemote(sessionKey, {
            content: { text: "Inspect this.", type: "text" },
            meta: {
                effort: "low",
                model: "gpt-test",
                modelProviderId: "codex",
                permissionMode: "read_only",
                sentFrom: "ios",
            },
            role: "user",
        });
        let allowText = false;
        const socket = new FakeSocket();
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/v1/sessions")) {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return Response.json({
                    session: {
                        id: "remote-1",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.endsWith("/attachments/request-download")) {
                return Response.json({ downloadUrl: "https://happy.test/blob/photo.enc" });
            }
            if (url.endsWith("/blob/photo.enc")) return new Response(encryptedImage);
            if (!allowText) {
                return Response.json({
                    hasMore: false,
                    messages: [remoteMessage("mobile-file", 1, filePayload)],
                });
            }
            return Response.json({
                hasMore: false,
                messages: [
                    remoteMessage("mobile-file", 1, filePayload),
                    remoteMessage("mobile-text", 2, textPayload),
                ],
            });
        });
        const client = new HappySessionClient({
            configuration: configuration(account.publicKey),
            fetch: request,
            repository,
            session: harness.session,
            socketFactory: () => socket,
        });
        client.start();

        await waitFor(() =>
            request.mock.calls.some(([input]) =>
                String(input).endsWith("/attachments/request-download"),
            ),
        );
        expect(repository.getSession("session-1")?.lastRemoteSeq).toBe(0);
        allowText = true;
        client.kick();
        await waitFor(() => submitted.length === 1);
        expect(harness.changedModels).toEqual([
            { effort: "low", modelId: "gpt-test", providerId: "codex" },
        ]);
        expect(harness.changedPermissionModes).toEqual(["read_only"]);
        expect(submitted).toEqual([
            expect.objectContaining({
                clientSubmissionId: "happy:mobile-text",
                content: [
                    { text: "Inspect this.", type: "text" },
                    { data: "AQIDBA==", mediaType: "image/png", type: "image" },
                ],
            }),
        ]);
        expect(repository.getSession("session-1")?.lastRemoteSeq).toBe(2);

        harness.snapshot.status = "running";
        harness.snapshot.activeTurn = { runId: "run-1", startedAt: 1 };
        harness.snapshot.pendingSteeringMessages = [
            {
                createdAt: 2,
                message: {
                    blocks: [{ text: "Apply this direction now.", type: "text" }],
                    id: "happy:pending-direction",
                    role: "user",
                },
                runId: "run-1",
            },
        ];
        const rpcResponse = await socket.requestRpc({
            method: "remote-1:abort",
            params: encodeRemote(sessionKey, { reason: "Stop" }),
        });
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(rpcResponse, "base64")),
        ).toEqual({ aborted: true, continued: true });
        expect(harness.abortCalls).toBe(1);
        expect(harness.abortRequests).toEqual([
            {
                continuePendingSteering: true,
                expectedRunId: "run-1",
                steeringMessageIds: ["happy:pending-direction"],
            },
        ]);

        harness.snapshot.pendingSteeringMessages = [
            {
                createdAt: 3,
                message: {
                    blocks: [{ text: "Background work completed.", type: "text" }],
                    id: "notification-1",
                    provenance: "agent",
                    role: "user",
                },
                runId: "run-1",
            },
        ];
        const hardStopResponse = await socket.requestRpc({
            method: "remote-1:abort",
            params: encodeRemote(sessionKey, { reason: "Stop" }),
        });
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(hardStopResponse, "base64")),
        ).toEqual({ aborted: true });
        expect(harness.abortCalls).toBe(2);
        expect(harness.abortRequests.at(-1)).toBeUndefined();

        const archiveResponse = await socket.requestRpc({
            method: "remote-1:killSession",
            params: encodeRemote(sessionKey, {}),
        });
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(archiveResponse, "base64")),
        ).toEqual({ success: true });
        expect(harness.snapshot.archived).toBe(true);

        await client.close();
        repository.close();
    });

    it("publishes a pending question to Happy and applies the answer that comes back", async () => {
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const { repository } = await createRepository();
        const sessionKey = new Uint8Array(32).fill(7);
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(9));
        repository.ensureSession({
            credentialFingerprint: "account",
            encryptionKey: sessionKey,
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const harness = fakeSession([]);
        const socket = new FakeSocket();
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/v1/sessions")) {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return Response.json({
                    session: {
                        agentStateVersion: 0,
                        id: "remote-1",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            return Response.json({ hasMore: false, messages: [] });
        });
        const client = new HappySessionClient({
            configuration: configuration(account.publicKey),
            fetch: request,
            repository,
            session: harness.session,
            socketFactory: () => socket,
        });
        client.start();
        await waitFor(() => socket.emitted.some(([event]) => event === "session-alive"));

        // Nothing is asked yet, so Happy should not have been told about any
        // pending communication.
        expect(socket.emitted.some(([event]) => event === "update-state")).toBe(false);

        harness.snapshot.pendingUserInputs = [
            {
                questions: [
                    {
                        header: "Storage",
                        id: "question_1",
                        multiSelect: false,
                        options: [
                            { description: "Sync everywhere", label: "In settings" },
                            { description: "Device only", label: "Locally" },
                        ],
                        question: "Where should the order live?",
                    },
                ],
                requestId: "call-1",
            },
        ];
        client.kick();
        await waitFor(() => socket.emitted.some(([event]) => event === "update-state"));

        const published = socket.emitted.find(([event]) => event === "update-state")?.[1] as any;
        const pendingState = decryptHappyPayload(
            sessionKey,
            "dataKey",
            Buffer.from(published.agentState, "base64"),
        ) as any;
        expect(pendingState).toMatchObject({
            communications: {
                "call-1": {
                    createdAt: 1_000,
                    form: {
                        questions: [
                            expect.objectContaining({ question: "Where should the order live?" }),
                        ],
                    },
                    kind: "form",
                    toolUseId: "call-1",
                },
            },
        });

        now = 2_000;
        const aliveCount = socket.emitted.filter(([event]) => event === "session-alive").length;
        client.kick();
        await waitFor(
            () => socket.emitted.filter(([event]) => event === "session-alive").length > aliveCount,
        );
        expect(socket.emitted.filter(([event]) => event === "update-state")).toHaveLength(1);

        // Happy answers on the communication channel, keyed by question id.
        now = 3_000;
        const rpcResponse = await socket.requestRpc({
            method: "remote-1:communication",
            params: encodeRemote(sessionKey, {
                answers: { question_1: { options: ["Locally"] } },
                id: "call-1",
                kind: "form",
                status: "answered",
            }),
        });
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(rpcResponse, "base64")),
        ).toEqual({ success: true });
        expect(harness.answeredUserInputs).toEqual([
            { requestId: "call-1", response: { answers: { question_1: ["Locally"] } } },
        ]);
        await waitFor(
            () => socket.emitted.filter(([event]) => event === "update-state").length === 2,
        );
        const completed = socket.emitted.filter(([event]) => event === "update-state")[1]?.[1];
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(completed.agentState, "base64")),
        ).toMatchObject({
            completedCommunications: {
                "call-1": {
                    answers: { question_1: { options: ["Locally"] } },
                    completedAt: 3_000,
                    createdAt: 1_000,
                    kind: "form",
                    status: "answered",
                },
            },
        });

        now = 4_000;
        harness.snapshot.pendingUserInputs = [
            {
                questions: [
                    {
                        header: "Branch",
                        id: "question_2",
                        multiSelect: false,
                        options: [{ description: "Keep going", label: "Continue" }],
                        question: "Continue this run?",
                    },
                ],
                requestId: "call-2",
            },
        ];
        client.kick();
        await waitFor(
            () => socket.emitted.filter(([event]) => event === "update-state").length === 3,
        );

        now = 5_000;
        const deniedResponse = await socket.requestRpc({
            method: "remote-1:communication",
            params: encodeRemote(sessionKey, {
                id: "call-2",
                kind: "form",
                status: "cancelled",
            }),
        });
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(deniedResponse, "base64")),
        ).toEqual({ success: true });
        expect(harness.abortCalls).toBe(1);
        expect(harness.snapshot.pendingUserInputs).toEqual([]);
        await waitFor(
            () => socket.emitted.filter(([event]) => event === "update-state").length === 4,
        );
        const cancelled = socket.emitted.filter(([event]) => event === "update-state")[3]?.[1];
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(cancelled.agentState, "base64")),
        ).toMatchObject({
            completedCommunications: {
                "call-2": {
                    completedAt: 5_000,
                    createdAt: 4_000,
                    status: "cancelled",
                },
            },
        });

        await client.close();
        repository.close();
    });

    it("clears stale agent state when reconnecting an existing Happy session", async () => {
        const { repository } = await createRepository();
        const sessionKey = new Uint8Array(32).fill(7);
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(9));
        repository.ensureSession({
            credentialFingerprint: "account",
            encryptionKey: sessionKey,
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const socket = new FakeSocket();
        const request = vi.fn<typeof fetch>(async (input) => {
            if (String(input).endsWith("/v1/sessions")) {
                return Response.json({
                    session: {
                        agentState: encodeRemote(sessionKey, {
                            communications: {
                                stale: {
                                    createdAt: 1,
                                    form: { questions: [] },
                                    kind: "form",
                                },
                            },
                            completedCommunications: {},
                        }),
                        agentStateVersion: 7,
                        id: "remote-1",
                        metadataVersion: 0,
                    },
                });
            }
            return Response.json({ hasMore: false, messages: [] });
        });
        const client = new HappySessionClient({
            configuration: configuration(account.publicKey),
            fetch: request,
            repository,
            session: fakeSession([]).session,
            socketFactory: () => socket,
        });
        client.start();

        await waitFor(() => socket.emitted.some(([event]) => event === "update-state"));
        expect(socket.emitted.find(([event]) => event === "update-state")?.[1]).toMatchObject({
            agentState: null,
            expectedVersion: 7,
            sid: "remote-1",
        });

        await client.close();
        repository.close();
    });

    it("retries a versioned metadata update after a concurrent Happy update", async () => {
        const { repository } = await createRepository();
        const sessionKey = new Uint8Array(32).fill(7);
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(9));
        repository.ensureSession({
            credentialFingerprint: "account",
            encryptionKey: sessionKey,
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        let acknowledgement = 0;
        const socket = new FakeSocket((value) => {
            acknowledgement += 1;
            return acknowledgement === 1
                ? {
                      metadata: encodeRemote(sessionKey, {
                          archivedBy: "user",
                          lifecycleState: "archiveRequested",
                      }),
                      result: "version-mismatch",
                      version: 4,
                  }
                : { result: "success", version: Number(value.expectedVersion) + 1 };
        });
        const request = vi.fn<typeof fetch>(async (input) => {
            if (String(input).endsWith("/v1/sessions")) {
                return Response.json({
                    session: {
                        id: "remote-1",
                        metadata: encodeRemote(sessionKey, { name: "Stale" }),
                        metadataVersion: 3,
                    },
                });
            }
            return Response.json({ hasMore: false, messages: [] });
        });
        const client = new HappySessionClient({
            configuration: configuration(account.publicKey),
            fetch: request,
            repository,
            session: fakeSession([]).session,
            socketFactory: () => socket,
        });
        client.start();

        await waitFor(
            () => socket.emitted.filter(([event]) => event === "update-metadata").length === 2,
        );
        expect(
            socket.emitted
                .filter(([event]) => event === "update-metadata")
                .map(([, value]) => value.expectedVersion),
        ).toEqual([3, 4]);
        const finalUpdate = socket.emitted.filter(([event]) => event === "update-metadata")[1]?.[1];
        expect(
            decryptHappyPayload(sessionKey, "dataKey", Buffer.from(finalUpdate.metadata, "base64")),
        ).toMatchObject({
            archivedBy: "user",
            lifecycleState: "archiveRequested",
            session: { status: "idle" },
        });

        await client.close();
        repository.close();
    });
});

class FakeSocket {
    connected = false;
    emitted: Array<[string, any]> = [];
    listeners = new Map<string, (...arguments_: any[]) => void>();

    constructor(
        private readonly metadataAnswer: (value: any) => unknown = (value) => ({
            result: "success",
            version: Number(value.expectedVersion) + 1,
        }),
    ) {}

    connect(): void {
        this.connected = true;
        this.listeners.get("connect")?.();
    }

    disconnect(): void {}

    emit(event: string, ...values: any[]): void {
        const value = values[0];
        this.emitted.push([event, value]);
        const callback = values.find((candidate) => typeof candidate === "function") as
            | ((answer: unknown) => void)
            | undefined;
        if ((event === "update-metadata" || event === "update-state") && callback) {
            callback(this.metadataAnswer(value));
        }
    }

    on(event: string, listener: (...arguments_: any[]) => void): void {
        this.listeners.set(event, listener);
    }

    requestRpc(request: unknown): Promise<string> {
        return new Promise((resolve) => this.listeners.get("rpc-request")?.(request, resolve));
    }
}

function fakeSession(submitted: unknown[]): {
    activity: any;
    abortCalls: number;
    abortRequests: (AbortRunOptions | undefined)[];
    answeredUserInputs: { requestId: string; response: unknown }[];
    changedModels: unknown[];
    changedPermissionModes: string[];
    session: InMemorySession;
    snapshot: any;
} {
    const answeredUserInputs: { requestId: string; response: unknown }[] = [];
    const submittedIds = new Set<string>();
    const changedModels: unknown[] = [];
    const changedPermissionModes: string[] = [];
    const abortRequests: (AbortRunOptions | undefined)[] = [];
    let abortCalls = 0;
    const activity: any = { kind: "idle", label: "Idle", since: 0 };
    const snapshot: any = {
        agent: { type: "primary" },
        backgroundProcesses: [],
        cwd: "/workspace",
        effort: "high",
        mcpServers: [],
        modelId: "gpt-test",
        modelLocked: false,
        models: [
            {
                defaultThinkingLevel: "high",
                id: "gpt-test",
                name: "GPT Test",
                thinkingLevels: ["low", "high"],
            },
        ],
        pendingUserInputs: [],
        permissionMode: "auto",
        providerId: "codex",
        skills: [],
        snapshot: { tools: [] },
        status: "idle",
        tasks: [],
        title: "Test session",
        workflows: [],
    };
    const harness = {
        get abortCalls() {
            return abortCalls;
        },
        abortRequests,
        activity,
        answeredUserInputs,
        changedModels,
        changedPermissionModes,
        session: {
            activity: () => structuredClone(activity),
            abort: async (options?: AbortRunOptions) => {
                abortCalls += 1;
                abortRequests.push(options);
                snapshot.pendingUserInputs = [];
                return {
                    aborted: true,
                    ...(options?.continuePendingSteering === true ? { continued: true } : {}),
                };
            },
            changeEffort: ({ effort }: { effort: string }) => {
                snapshot.effort = effort;
            },
            changeModel: (request: { effort?: string; modelId: string; providerId?: string }) => {
                changedModels.push(request);
                snapshot.modelId = request.modelId;
                snapshot.providerId = request.providerId ?? snapshot.providerId;
                snapshot.effort = request.effort ?? snapshot.effort;
            },
            changePermissionMode: async ({ permissionMode }: { permissionMode: string }) => {
                changedPermissionModes.push(permissionMode);
                snapshot.permissionMode = permissionMode;
            },
            events: {
                messageSubmission: (id: string) =>
                    submittedIds.has(id)
                        ? { data: { message: { id } }, type: "message_submitted" }
                        : undefined,
                since: () =>
                    [...submittedIds].map((id) => ({
                        data: { message: { id } },
                        type: "message_submitted",
                    })),
            },
            answerUserInput: (requestId: string, response: unknown) => {
                const pending = snapshot.pendingUserInputs.find(
                    (candidate: { requestId: string }) => candidate.requestId === requestId,
                );
                const answers = (response as { answers?: Record<string, unknown> }).answers ?? {};
                for (const question of pending?.questions ?? []) {
                    const selected = answers[question.id];
                    if (
                        question.required !== false &&
                        (!Array.isArray(selected) || selected.length === 0)
                    ) {
                        throw new Error(
                            `Answer the ${question.header} question before continuing.`,
                        );
                    }
                }
                answeredUserInputs.push({ requestId, response });
                snapshot.pendingUserInputs = snapshot.pendingUserInputs.filter(
                    (pending: { requestId: string }) => pending.requestId !== requestId,
                );
                return snapshot;
            },
            id: "session-1",
            setArchived: (archived: boolean) => {
                snapshot.archived = archived;
                return snapshot;
            },
            snapshot: () => snapshot,
            submit: (request: { clientSubmissionId: string }) => {
                submitted.push(request);
                submittedIds.add(request.clientSubmissionId);
            },
        } as unknown as InMemorySession,
        snapshot,
    };
    return harness;
}

function encodeRemote(key: Uint8Array, value: unknown): string {
    return Buffer.from(encryptHappyPayload(key, "dataKey", value)).toString("base64");
}

function remoteMessage(id: string, seq: number, content: string): HappyRemoteMessage {
    return {
        content: { c: content, t: "encrypted" },
        createdAt: seq,
        id,
        localId: null,
        seq,
        updatedAt: seq,
    };
}

function deriveBlobKey(key: Uint8Array, variant: "dataKey" | "legacy"): Uint8Array {
    // Match Happy's deriveKey(seed, "Happy Blobs", [path]): the usage label is
    // the root HMAC key and the session data key is its payload.
    const root = createHmac("sha512", "Happy Blobs Master Seed").update(key).digest();
    const path = variant === "dataKey" ? "session" : "master";
    return new Uint8Array(
        createHmac("sha512", root.subarray(32))
            .update(new Uint8Array([0, ...new TextEncoder().encode(path)]))
            .digest()
            .subarray(0, 32),
    );
}

function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(NACL_NONCE_BYTES).fill(3);
    const encrypted = nobleSecretBoxSeal(data, nonce, key);
    return new Uint8Array([...nonce, ...encrypted]);
}

function configuration(publicKey: Uint8Array): HappyConnectionConfiguration {
    return {
        credentials: {
            encryption: {
                machineKey: new Uint8Array(32).fill(10),
                publicKey,
                type: "dataKey",
            },
            token: "token",
        },
        credentialsPath: "/rig/happy/access.key",
        happyHome: "/rig/happy",
        imported: false,
        serverUrl: "https://happy.test",
    };
}

function unwrapDataKey(value: string, accountSecretKey: Uint8Array): Uint8Array | undefined {
    const bundle = new Uint8Array(Buffer.from(value, "base64"));
    if (bundle[0] !== 0) return undefined;
    return nobleBoxOpen(
        bundle.slice(57),
        bundle.slice(33, 57),
        bundle.slice(1, 33),
        accountSecretKey,
    );
}

async function createRepository() {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-client-"));
    directories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    createSessionDatabaseFixture(databasePath);
    return { databasePath, repository: new HappySyncRepository(databasePath) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for Happy synchronization.");
}
