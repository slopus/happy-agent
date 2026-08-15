import type { Span, Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InMemorySession } from "../../session/InMemorySession.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { HappySessionClient } from "../HappySessionClient.js";
import type { HappySyncRepository, HappySessionState } from "../HappySyncRepository.js";

describe("HappySessionClient idle synchronization", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("does not poll the repository or network after a successful idle sync", async () => {
        vi.useFakeTimers();
        const ctx = createTestRootContext().named("happy-idle-client");
        const state: HappySessionState = {
            credentialFingerprint: "account",
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: "dataKey",
            historyBackfilled: true,
            lastRemoteSeq: 0,
            projectionStatus: "active",
            remoteSessionId: "remote-1",
            sessionId: "session-1",
            tag: "rig:session-1",
        };
        const getSession = vi.fn(async () => state);
        const pending = vi.fn(async () => []);
        const repository = {
            acknowledge: vi.fn(),
            getSession,
            pending,
            setRemoteSession: vi.fn(),
            updateLastRemoteSeq: vi.fn(),
        } as unknown as HappySyncRepository;
        const request = vi.fn<typeof fetch>(async (input, init) =>
            String(input).endsWith("/v1/sessions") && init?.method === "POST"
                ? Response.json({
                      session: { id: "remote-1", metadataVersion: 0 },
                  })
                : Response.json({ hasMore: false, messages: [] }),
        );
        const socket = new IdleSocket();
        const client = new HappySessionClient({
            configuration: {
                credentials: {
                    encryption: {
                        machineKey: new Uint8Array(32).fill(10),
                        publicKey: new Uint8Array(32).fill(9),
                        type: "dataKey",
                    },
                    token: "token",
                },
                credentialsPath: "/rig/happy/access.key",
                happyHome: "/rig/happy",
                imported: false,
                serverUrl: "https://happy.test",
            },
            fetch: request,
            repository,
            session: idleSession(),
            socketFactory: () => socket,
        });

        client.start(ctx);
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalled();
        const completedCounts = {
            getSession: getSession.mock.calls.length,
            pending: pending.mock.calls.length,
            request: request.mock.calls.length,
        };

        await vi.advanceTimersByTimeAsync(60_000);
        for (let index = 0; index < 10; index += 1) await Promise.resolve();

        expect({
            getSession: getSession.mock.calls.length,
            pending: pending.mock.calls.length,
            request: request.mock.calls.length,
        }).toEqual(completedCounts);
        await client.close(ctx);
    });

    it("runs nonblocking startup synchronization in its own bounded worker context", async () => {
        let releaseFirstRead!: () => void;
        let firstRead = true;
        const getSession = vi.fn(async () => {
            if (firstRead) {
                firstRead = false;
                await new Promise<void>((resolve) => {
                    releaseFirstRead = resolve;
                });
            }
            return undefined;
        });
        const repository = { getSession } as unknown as HappySyncRepository;
        const client = new HappySessionClient({
            configuration: {
                credentials: {
                    encryption: {
                        machineKey: new Uint8Array(32).fill(10),
                        publicKey: new Uint8Array(32).fill(9),
                        type: "dataKey",
                    },
                    token: "token",
                },
                credentialsPath: "/rig/happy/access.key",
                happyHome: "/rig/happy",
                imported: false,
                serverUrl: "https://happy.test",
            },
            repository,
            session: idleSession(),
            socketFactory: () => new IdleSocket(),
        });
        const started: string[] = [];
        const ended: string[] = [];
        const caller = createTestRootContext(lifecycleTracer(started, ended));

        caller.span("test.happy.start-caller", (ctx) => client.start(ctx));
        await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());

        expect(ended).toContain("test.happy.start-caller");
        expect(started).toContain("rig.worker.happy-session-sync");
        expect(ended).not.toContain("rig.worker.happy-session-sync");

        releaseFirstRead();
        await vi.waitFor(() => expect(ended).toContain("rig.worker.happy-session-sync"));
        await client.close(caller);
    });

    it("ends one finite sync worker per pass while updates keep the controller dirty", async () => {
        const state: HappySessionState = {
            credentialFingerprint: "account",
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: "dataKey",
            historyBackfilled: true,
            lastRemoteSeq: 0,
            projectionStatus: "active",
            remoteSessionId: "remote-1",
            sessionId: "session-1",
            tag: "rig:session-1",
        };
        const started: string[] = [];
        const ended: string[] = [];
        const caller = createTestRootContext(lifecycleTracer(started, ended));
        let dirtyPasses = 0;
        let client!: HappySessionClient;
        const repository = {
            acknowledge: vi.fn(),
            getSession: vi.fn(async () => state),
            pending: vi.fn(async () => {
                dirtyPasses += 1;
                if (dirtyPasses < 4) client.kick(caller);
                return [];
            }),
            setRemoteSession: vi.fn(),
            updateLastRemoteSeq: vi.fn(),
        } as unknown as HappySyncRepository;
        const request = vi.fn<typeof fetch>(async (input, init) =>
            String(input).endsWith("/v1/sessions") && init?.method === "POST"
                ? Response.json({
                      session: { id: "remote-1", metadataVersion: 0 },
                  })
                : Response.json({ hasMore: false, messages: [] }),
        );
        client = new HappySessionClient({
            configuration: {
                credentials: {
                    encryption: {
                        machineKey: new Uint8Array(32).fill(10),
                        publicKey: new Uint8Array(32).fill(9),
                        type: "dataKey",
                    },
                    token: "token",
                },
                credentialsPath: "/rig/happy/access.key",
                happyHome: "/rig/happy",
                imported: false,
                serverUrl: "https://happy.test",
            },
            fetch: request,
            repository,
            session: idleSession(),
            socketFactory: () => new IdleSocket(),
        });

        client.start(caller);
        await vi.waitFor(() => expect(dirtyPasses).toBe(4));
        await vi.waitFor(() =>
            expect(ended.filter((name) => name === "rig.worker.happy-session-sync")).toHaveLength(
                4,
            ),
        );

        expect(started.filter((name) => name === "rig.worker.happy-session-sync")).toHaveLength(4);
        await client.close(caller);
    });
});

class IdleSocket {
    connected = true;

    connect(): void {}
    disconnect(): void {}

    emit(event: string, ...values: unknown[]): void {
        const callback = values.find((value) => typeof value === "function") as
            | ((answer: unknown) => void)
            | undefined;
        if (event === "update-metadata") callback?.({ result: "success", version: 1 });
    }

    on(): void {}
}

function idleSession(): InMemorySession {
    const snapshot = {
        agent: { type: "primary" },
        backgroundProcesses: [],
        cwd: "/workspace",
        effort: "high",
        mcpServers: [],
        modelId: "gpt-test",
        modelLocked: false,
        models: [],
        pendingUserInputs: [],
        permissionMode: "auto",
        providerId: "codex",
        scope: { kind: "unsorted" },
        snapshot: { tools: [] },
        status: "idle",
        tasks: [],
        title: "Idle session",
        workflows: [],
    };
    return {
        activity: () => ({ kind: "idle", label: "Idle", since: 0 }),
        clientSnapshot: () => snapshot,
        events: { messageSubmission: () => undefined },
        id: "session-1",
    } as unknown as InMemorySession;
}

function lifecycleTracer(started: string[], ended: string[]): Tracer {
    return {
        startSpan(name: string) {
            started.push(name);
            const span: Span = {
                addEvent: () => span,
                addLink: () => span,
                addLinks: () => span,
                end: () => ended.push(name),
                isRecording: () => true,
                recordException: () => undefined,
                setAttribute: () => span,
                setAttributes: () => span,
                setStatus: () => span,
                spanContext: () => ({
                    spanId: "2".repeat(16),
                    traceFlags: 1,
                    traceId: "1".repeat(32),
                }),
                updateName: () => span,
            };
            return span;
        },
    } as unknown as Tracer;
}
