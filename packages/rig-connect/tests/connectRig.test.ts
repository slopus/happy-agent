import { describe, expect, it, vi } from "vitest";

import type { ChatDelta, MutationRejectedDelta } from "@/ChatElement.js";
import {
    connectRig,
    MAXIMUM_RIG_PROTOCOL_VERSION,
    ProjectRegistrationError,
    ProjectRegistrationProtocolError,
} from "@/index.js";
import type { SessionFinished } from "@/connectRig.js";
import type {
    GlobalStreamHello,
    SessionStateResponse,
    SessionSummary,
    SessionTranscriptWindow,
} from "@/protocol.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, reject, resolve };
}

function streamResponse() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
        },
    });
    return {
        close: () => controller.close(),
        response: new Response(body, { status: 200 }),
        write: (frame: string) => controller.enqueue(encoder.encode(frame)),
    };
}

function sessionState(modelId = "old-model"): SessionStateResponse {
    return {
        cursor: "01900000-0000-7000-8000-000000000001",
        activity: { kind: "idle", label: "Idle", since: 1 },
        lastEventId: "01900000-0000-7000-8000-000000000001",
        resumed: false,
        session: {
            activity: { kind: "idle", label: "Idle", since: 1 },
            archived: false,
            cwd: "/work",
            id: "session-1",
            lastEventId: "01900000-0000-7000-8000-000000000001",
            modelLocked: false,
            modelCatalog: {
                defaultModelId: modelId,
                defaultProviderId: "codex",
                models: [],
                providers: [],
            },
            modelId,
            models: [],
            ownerInstanceId: "alocalinstance00000000001",
            orderKey: "a",
            pendingUserInputs: [],
            permissionMode: "auto",
            scope: { kind: "project", projectId: "project-1" },
            providerId: "codex",
            snapshot: { messages: [] },
            status: "idle",
            tasks: [],
        },
    };
}

function transcriptWindow(runs: readonly number[], complete: boolean): SessionTranscriptWindow {
    const messages = runs.map((run) => ({
        blocks: [{ text: `Message ${String(run)}`, type: "text" as const }],
        id: `message-${String(run)}`,
        role: "user" as const,
    }));
    return {
        complete,
        messageCreatedAt: Object.fromEntries(
            runs.map((run) => [`message-${String(run)}`, run * 100]),
        ),
        messageEventId: Object.fromEntries(
            runs.map((run) => [
                `message-${String(run)}`,
                `01900000-0000-7000-8000-${String(run).padStart(12, "0")}`,
            ]),
        ),
        messages,
        turns: runs.map((run) => ({
            endedAt: run * 100 + 50,
            messageIds: [`message-${String(run)}`],
            outcome: "success" as const,
            runId: `run-${String(run)}`,
            startedAt: run * 100,
        })),
    };
}

function sessionStateWithTranscript(
    transcript: SessionTranscriptWindow,
    append = false,
): SessionStateResponse {
    const state = sessionState();
    return {
        ...state,
        ...(append ? { append: true } : {}),
        session: {
            ...state.session!,
            snapshot: { ...state.session!.snapshot, messages: transcript.messages },
        },
        transcript,
    };
}

function groupsCatalog(): Omit<GlobalStreamHello, "cursor"> {
    return {
        catalog: {
            defaultModelId: "sonnet-5",
            defaultProviderId: "claude",
            models: [],
            providers: [],
        },
        folderItems: [],
        folders: [],
        presence: {
            presence: {
                answerWaitMs: null,
                emoji: "🟢",
                id: "online",
                prompt: "The user is at the keyboard.",
                title: "Online",
            },
            presences: [
                {
                    answerWaitMs: null,
                    emoji: "🟢",
                    id: "online",
                    prompt: "The user is at the keyboard.",
                    title: "Online",
                },
            ],
            since: 0,
        },
        identity: { version: "test" },
        protocolVersion: 17,
        projects: [
            {
                createdAt: 1,
                id: "project-1",
                initializationAttempt: 1,
                initializationStatus: "ready",
                kind: "regular",
                name: "Before",
                nameSource: "folder",
                orderKey: "a",
                path: "/work",
                presence: "present",
                settings: {},
                storageKey: "project-1",
                updatedAt: 1,
                version: 3,
                worktreeSupport: "supported",
            },
        ],
        sessions: [],
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    };
}

function catalogSession(): SessionSummary {
    return {
        ...sessionState().session!,
        createdAt: 1,
        titleStatus: "idle",
        updatedAt: 1,
    };
}

/** What the daemon reports back for a workspace the client named itself. */
function daemonWorkspace(id: string) {
    return {
        baseRef: "main",
        branch: `worktree/${id}`,
        createdAt: 2,
        gitCommonDir: "/work/.git",
        id,
        kind: "git_worktree" as const,
        name: "Feature",
        orderKey: "a",
        path: "/work/feature",
        presence: "present" as const,
        projectId: "project-1",
        status: "ready" as const,
        storageKey: id,
        updatedAt: 2,
        version: 1,
    };
}

/** The light hello the live stream opens with: a position, and nothing else. */
function liveHello(
    cursor = "01900000-0000-7000-8000-000000000001",
    options: { gap?: boolean; resumed?: boolean } = {},
): string {
    return `event: hello\ndata: ${JSON.stringify({
        cursor,
        gap: options.gap ?? false,
        protocolVersion: 17,
        resumed: options.resumed ?? false,
    })}\n\n`;
}

function event(
    type: string,
    data: Record<string, unknown>,
    id = "01900000-0000-7000-8000-000000000002",
): string {
    return `id: ${id}\nevent: update\ndata: ${JSON.stringify({
        cursor: id,
        event: { createdAt: 2, data, id, sessionId: "session-1", type },
    })}\n\n`;
}

/** A global-scope frame: no session owns it, so it carries its own entity scope. */
function globalEvent(
    type: string,
    data: Record<string, unknown>,
    scope: Record<string, string>,
    id = "01900000-0000-7000-8000-000000000003",
): string {
    return `id: ${id}\nevent: update\ndata: ${JSON.stringify({
        cursor: id,
        event: { createdAt: 2, data, id, type, ...scope },
    })}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const randomValues = (bytes: Uint8Array): Uint8Array => {
    bytes.fill(1);
    return bytes;
};

describe("connectRig mutations", () => {
    it("retries project registration with one identity and returns the authoritative entity", async () => {
        const bodies: { path: string; projectId: string }[] = [];
        const project = {
            ...groupsCatalog().projects[0]!,
            id: "registered-project",
            path: "/projects/registered",
        };
        let attempt = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                attempt += 1;
                if (attempt === 1) return Promise.reject(new TypeError("connection lost"));
                return Promise.resolve(new Response(JSON.stringify({ project }), { status: 200 }));
            },
            mutationRetryDelayMs: 1,
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        try {
            await expect(rig.projects.add("/projects/registered")).resolves.toEqual(project);
            expect(bodies).toHaveLength(2);
            expect(bodies[0]).toEqual(bodies[1]);
            expect(bodies[0]).toMatchObject({ path: "/projects/registered" });
            expect(bodies[0]?.projectId).toEqual(expect.any(String));
        } finally {
            rig.close();
        }
    });

    it("throws displayable typed project registration failures", async () => {
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: () =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            error: {
                                code: "not_git_top_level",
                                message: "Choose the Git repository's top-level folder.",
                            },
                        }),
                        { status: 422 },
                    ),
                ),
            randomValues,
            token: "secret",
        });
        try {
            const error = await rig.projects.add("/projects/nested").catch((reason) => reason);
            expect(error).toBeInstanceOf(ProjectRegistrationError);
            expect(error).toMatchObject({
                code: "not_git_top_level",
                message: "Choose the Git repository's top-level folder.",
                status: 422,
            });
        } finally {
            rig.close();
        }
    });

    it("terminates permanent and undecodable project registration failures", async () => {
        let serverAttempts = 0;
        const serverFailure = connectRig({
            endpoint: "http://daemon.test",
            fetch: () => {
                serverAttempts += 1;
                return Promise.resolve(new Response("unavailable", { status: 500 }));
            },
            mutationRetryDelayMs: 1,
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        try {
            const error = await serverFailure.projects
                .add("/projects/server-failure")
                .catch((reason) => reason);
            expect(error).toBeInstanceOf(ProjectRegistrationProtocolError);
            expect(error).toMatchObject({
                code: "request_failed",
                status: 500,
            });
            expect(serverAttempts).toBe(3);
        } finally {
            serverFailure.close();
        }

        let refusalAttempts = 0;
        const malformedRefusal = connectRig({
            endpoint: "http://daemon.test",
            fetch: () => {
                refusalAttempts += 1;
                return Promise.resolve(new Response("invalid", { status: 409 }));
            },
            randomValues,
            token: "secret",
        });
        try {
            const error = await malformedRefusal.projects
                .add("/projects/malformed-refusal")
                .catch((reason) => reason);
            expect(error).toBeInstanceOf(ProjectRegistrationProtocolError);
            expect(error).toMatchObject({
                code: "request_failed",
                status: 409,
            });
            expect(refusalAttempts).toBe(1);
        } finally {
            malformedRefusal.close();
        }

        const malformedSuccess = connectRig({
            endpoint: "http://daemon.test",
            fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
            randomValues,
            token: "secret",
        });
        try {
            const error = await malformedSuccess.projects
                .add("/projects/malformed-success")
                .catch((reason) => reason);
            expect(error).toBeInstanceOf(ProjectRegistrationProtocolError);
            expect(error).toMatchObject({
                code: "invalid_response",
                status: 200,
            });
        } finally {
            malformedSuccess.close();
        }
    });

    it("supports loading process output and terminal presence through the shared transport", async () => {
        const calls: { init?: RequestInit; url: URL }[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                calls.push({ ...(init === undefined ? {} : { init }), url });
                return Promise.resolve(
                    new Response(
                        url.pathname.endsWith("/background-processes/12")
                            ? JSON.stringify({
                                  command: "pnpm test",
                                  cwd: "/work",
                                  exitCode: null,
                                  sessionId: 12,
                                  status: "running",
                                  stderr: "",
                                  stderrDelta: "",
                                  stdout: "passing",
                                  stdoutDelta: "passing",
                                  timedOut: false,
                              })
                            : "{}",
                        { status: 200 },
                    ),
                );
            },
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        try {
            const process = await rig.readBackgroundProcess("session-1", 12, { waitMs: 50 });
            expect(process?.stdout).toBe("passing");

            const presence = await rig.connectTerminalPresence("session-1", {
                focused: true,
                targetPid: 42,
            });
            await presence.setFocused(false);
            await presence.close();

            expect(calls.map((call) => call.init?.method ?? "GET")).toEqual([
                "GET",
                "PUT",
                "PUT",
                "DELETE",
            ]);
            expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
                focused: false,
                targetPid: 42,
            });
        } finally {
            rig.close();
        }
    });

    it("declares session Git interest and applies the current snapshot", async () => {
        const stream = streamResponse();
        let watchBody: unknown;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    watchBody = JSON.parse(String(init?.body)) as unknown;
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                snapshots: [
                                    {
                                        createdAt: 2,
                                        data: {
                                            git: {
                                                changedFiles: 1,
                                                comparison: "ready",
                                                conflicted: false,
                                                countsExact: true,
                                                deletions: 0,
                                                facts: {
                                                    ahead: 0,
                                                    behind: 0,
                                                    branch: "main",
                                                    detached: false,
                                                },
                                                files: [],
                                                filesTruncated: false,
                                                generation: "generation-1",
                                                insertions: 2,
                                                scannedAt: 2,
                                                version: 1,
                                            },
                                        },
                                        id: "01900000-0000-7000-8000-000000000003",
                                        projectId: "project-1",
                                        type: "project_git_changed",
                                    },
                                ],
                            }),
                            { status: 200 },
                        ),
                    );
                }
                return Promise.resolve(new Response("{}", { status: 200 }));
            },
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();

            expect(watchBody).toEqual({ entities: [{ projectId: "project-1" }] });
            expect(connection.session().git).toMatchObject({
                branch: "main",
                changedFiles: 1,
                insertions: 2,
            });

            stream.write(
                globalEvent(
                    "project_git_changed",
                    {
                        git: {
                            ...connection.session().git,
                            changedFiles: 2,
                            insertions: 4,
                            version: 2,
                        },
                    },
                    { projectId: "project-1" },
                    "01900000-0000-7000-8000-000000000004",
                ),
            );
            await settle();
            expect(connection.session().git).toMatchObject({
                changedFiles: 2,
                insertions: 4,
                version: 2,
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("uses client-selected identities for retry-safe create and fork", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                calls.push({ ...(init === undefined ? {} : { init }), url });
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                return Promise.resolve(
                    url.pathname.endsWith("/state")
                        ? new Response(JSON.stringify(sessionState()), { status: 200 })
                        : new Response("{}", { status: 200 }),
                );
            },
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            const createdId = rig.createSession({ cwd: "/new-work" });
            const forkedId = rig.forkSession("session-1");
            expect(createdId).not.toBe(forkedId);
            await settle();

            const createCall = calls.find(
                (call) => call.url.pathname === "/sessions" && call.init?.method === "POST",
            );
            // The client names the session it creates, and that name is a cuid2.
            expect(createdId).toMatch(/^[a-z][0-9a-z]{23}$/u);
            expect(JSON.parse(String(createCall?.init?.body))).toMatchObject({
                cwd: "/new-work",
                id: createdId,
            });
            const forkCall = calls.find((call) => call.url.pathname.endsWith("/fork"));
            expect(forkCall?.init?.headers).toMatchObject({
                "x-rig-mutation-id": forkedId,
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("applies the expanded session actions synchronously and delivers them FIFO", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const initialState = sessionState();
        initialState.session = {
            ...initialState.session!,
            scheduledMessages: [
                {
                    createdAt: 1,
                    dueAt: 2,
                    id: "scheduled-1",
                    message: "Check later.",
                    senderSessionId: "session-1",
                    status: "pending",
                    targetAgentId: "agent-1",
                    updatedAt: 1,
                },
            ],
        };
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                calls.push({ ...(init === undefined ? {} : { init }), url });
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                return Promise.resolve(
                    url.pathname.endsWith("/state")
                        ? new Response(JSON.stringify(initialState), { status: 200 })
                        : new Response("{}", { status: 200 }),
                );
            },
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            stream.write(
                event("user_input_requested", {
                    questions: [],
                    requestId: "question-1",
                }),
            );
            await settle();

            rig.setEffort("session-1", "high");
            expect(connection.session().effort).toBe("high");
            rig.setServiceTier("session-1", "priority");
            expect(connection.session().serviceTier).toBe("priority");
            rig.setPermissionMode("session-1", "full_access");
            expect(connection.session().permissionMode).toBe("full_access");
            rig.setDraft("session-1", "unfinished thought");
            expect(connection.session().draft).toBe("unfinished thought");
            rig.setAppendSystemPrompt("session-1", "Always verify.");
            expect(connection.session().appendSystemPrompt).toBe("Always verify.");
            rig.answerUserInput("session-1", "question-1", { answers: {} });
            expect(connection.session().pendingUserInputs).toEqual([]);
            rig.setGoal("session-1", "Ship the connector");
            expect(connection.session().goal?.objective).toBe("Ship the connector");
            rig.attachSecret("session-1", "secret-1");
            expect(connection.session().sessionSecretIds).toEqual(["secret-1"]);
            rig.runShellCommand("session-1", { command: "pwd", commandId: "shell-1" });
            expect(connection.session().shellCommands).toEqual([
                { command: "pwd", commandId: "shell-1", status: "running" },
            ]);
            rig.stopBackgroundProcesses("session-1");
            rig.stopBackgroundProcess("session-1", 12);
            rig.cancelScheduledMessage("session-1", "scheduled-1");
            expect(connection.session().scheduledMessages).toEqual([
                expect.objectContaining({ id: "scheduled-1", status: "cancelled" }),
            ]);
            rig.recordActivity("session-1");

            await settle();
            expect(
                calls
                    .filter(
                        (call) =>
                            call.url.pathname !== "/events/live" &&
                            call.url.pathname !== "/git/watch" &&
                            !call.url.pathname.endsWith("/state"),
                    )
                    .map((call) => `${call.init?.method} ${call.url.pathname}`),
            ).toEqual([
                "PATCH /sessions/session-1/effort",
                "PATCH /sessions/session-1/service-tier",
                "PATCH /sessions/session-1/permissions",
                "PUT /sessions/session-1/draft",
                "PATCH /sessions/session-1",
                "POST /sessions/session-1/user-input/question-1",
                "POST /sessions/session-1/goal",
                "POST /sessions/session-1/secrets",
                "POST /sessions/session-1/shell",
                "POST /sessions/session-1/background-processes/stop",
                "DELETE /sessions/session-1/background-processes/12",
                "POST /sessions/session-1/scheduled-messages/scheduled-1/cancel",
                "POST /sessions/session-1/activity",
            ]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("shows a sent message synchronously and reuses one session stream", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const profile = {
            createdAt: 1,
            email: "steve@example.test",
            id: "aprofile000000000000000001",
            name: "Steve",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 1,
            version: 1,
        };
        const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            calls.push({ ...(init === undefined ? {} : { init }), url });
            if (url.pathname === "/events/live") {
                return Promise.resolve(stream.response);
            }
            if (url.pathname === "/profiles") {
                return Promise.resolve(
                    new Response(JSON.stringify({ profiles: [profile] }), { status: 200 }),
                );
            }
            if (url.pathname.endsWith("/state")) {
                return Promise.resolve(
                    new Response(JSON.stringify(sessionState()), { status: 200 }),
                );
            }
            return Promise.resolve(
                new Response(JSON.stringify({ eventId: "event-send" }), { status: 202 }),
            );
        });
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch,
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const first = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        const second = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });

        try {
            stream.write(liveHello());
            await settle();
            const mutationId = rig.sendMessage("session-1", {
                identity: profile.id,
                text: "Visible now",
            });

            expect(typeof mutationId).toBe("string");
            expect(first.elements().at(-1)).toMatchObject({
                identity: profile.id,
                kind: "user_message",
                messageId: mutationId,
                text: "Visible now",
            });
            expect(second.elements()).toBe(first.elements());
            expect(calls.filter((call) => call.url.pathname === "/events/live")).toHaveLength(1);
            const sent = calls.find((call) => call.url.pathname.endsWith("/messages"));
            expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
                clientSubmissionId: mutationId,
                identity: profile.id,
                mutationId,
                text: "Visible now",
            });
            await settle();
            expect(first.elements().at(-1)).toMatchObject({ profile });
            expect((sent!.init!.headers as Record<string, string>)["if-match"]).toBe(
                '"01900000-0000-7000-8000-000000000001"',
            );
        } finally {
            first.close();
            second.close();
            rig.close();
        }
    });

    it("shows context optimistically without changing session activity", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            calls.push({ ...(init === undefined ? {} : { init }), url });
            if (url.pathname === "/events/live") return Promise.resolve(stream.response);
            if (url.pathname.endsWith("/state")) {
                return Promise.resolve(
                    new Response(JSON.stringify(sessionState()), { status: 200 }),
                );
            }
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        delivery: "context",
                        eventId: "event-context",
                        messageId: "context-message",
                        sessionId: "session-1",
                    }),
                    { status: 202 },
                ),
            );
        });
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch,
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });

        try {
            stream.write(liveHello());
            await settle();
            const sessionBefore = connection.session();
            const mutationId = rig.sendContextMessage("session-1", "Use the blue database.");
            const optimisticElement = connection.elements().at(-1);

            expect(optimisticElement).toMatchObject({
                contextOnly: true,
                kind: "user_message",
                messageId: mutationId,
                text: "Use the blue database.",
            });
            expect(connection.session().activity).toBe(sessionBefore.activity);
            expect(connection.session().status).toBe(sessionBefore.status);
            const sent = calls.find((call) => call.url.pathname.endsWith("/context"));
            expect(JSON.parse(String(sent?.init?.body))).toEqual({
                clientSubmissionId: mutationId,
                mutationId,
                text: "Use the blue database.",
            });

            stream.write(
                event(
                    "message_submitted",
                    {
                        delivery: "context",
                        displayText: "Use the blue database.",
                        message: {
                            blocks: [{ text: "Use the blue database.", type: "text" }],
                            contextOnly: true,
                            id: mutationId,
                            role: "user",
                        },
                        mutationId,
                        runId: `context:${mutationId}`,
                    },
                    "01900000-0000-7000-8000-000000000003",
                ),
            );
            await settle();
            expect(connection.elements()).toHaveLength(1);
            expect(connection.elements()[0]).toBe(optimisticElement);
            expect(connection.elements()[0]?.groupId).toBe(`group:context:${mutationId}`);
            expect(connection.session().activity).toBe(sessionBefore.activity);
            expect(connection.session().activeTurn).toBe(sessionBefore.activeTurn);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("steers the active run when sending a message during work", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const active = sessionState();
        const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            calls.push({ ...(init === undefined ? {} : { init }), url });
            if (url.pathname === "/events/live") return Promise.resolve(stream.response);
            if (url.pathname.endsWith("/state")) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            ...active,
                            activity: { kind: "thinking", label: "Thinking", since: 10 },
                            session: {
                                ...active.session!,
                                activeTurn: { runId: "run-active", startedAt: 10 },
                                activity: { kind: "thinking", label: "Thinking", since: 10 },
                                status: "running",
                            },
                        }),
                        { status: 200 },
                    ),
                );
            }
            return Promise.resolve(
                new Response(JSON.stringify({ delivery: "steer", eventId: "event-steer" }), {
                    status: 202,
                }),
            );
        });
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch,
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });

        try {
            stream.write(liveHello());
            await settle();
            const mutationId = rig.sendMessage("session-1", "Change direction");
            await settle();

            const sent = calls.find((call) => call.url.pathname.endsWith("/steer"));
            expect(sent).toBeDefined();
            expect(calls.some((call) => call.url.pathname.endsWith("/messages"))).toBe(false);
            expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
                clientSubmissionId: mutationId,
                expectedRunId: "run-active",
                mutationId,
                text: "Change direction",
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("retries a lost response with the same mutation identity", async () => {
        const stream = streamResponse();
        const bodies: Record<string, unknown>[] = [];
        let attempts = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                attempts += 1;
                return attempts === 1
                    ? Promise.reject(new TypeError("response lost"))
                    : Promise.resolve(
                          new Response(JSON.stringify({ eventId: "accepted" }), { status: 202 }),
                      );
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            rig.sendMessage("session-1", "Once");
            await settle();
            expect(attempts).toBe(2);
            expect(bodies[0]?.mutationId).toBe(bodies[1]?.mutationId);
            expect(bodies[0]?.clientSubmissionId).toBe(bodies[1]?.clientSubmissionId);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("treats a stale-precondition response as success when Rig already has the intent", async () => {
        const stream = streamResponse();
        const deltas: ChatDelta[] = [];
        let attempts = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                attempts += 1;
                return attempts === 1
                    ? Promise.reject(new TypeError("response lost"))
                    : Promise.resolve(
                          new Response(
                              JSON.stringify({
                                  error: "The session changed.",
                                  session: {
                                      lastEventId: "accepted",
                                      modelId: "new-model",
                                      providerId: "codex",
                                  },
                              }),
                              { status: 409 },
                          ),
                      );
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            onDelta: (delta) => deltas.push(delta),
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            rig.switchModel("session-1", "new-model");
            await settle();

            expect(attempts).toBe(2);
            expect(connection.session().modelId).toBe("new-model");
            expect(deltas.some((delta) => delta.type === "mutation_rejected")).toBe(false);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps a successful session prediction when HTTP wins the race with SSE", async () => {
        const stream = streamResponse();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            session: {
                                activity: { kind: "idle", label: "Idle", since: 2 },
                                archived: false,
                                cwd: "/work",
                                id: "session-1",
                                lastEventId: "01900000-0000-7000-8000-000000000002",
                                modelLocked: false,
                                modelId: "new-model",
                                models: [],
                                orderKey: "a",
                                pendingUserInputs: [],
                                permissionMode: "auto",
                                projectId: "project-1",
                                providerId: "codex",
                                snapshot: { messages: [] },
                                status: "idle",
                                tasks: [],
                            },
                        }),
                        { status: 200 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            rig.switchModel("session-1", "new-model");
            expect(connection.session().modelId).toBe("new-model");
            await settle();
            expect(connection.session().modelId).toBe("new-model");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps same-session actions FIFO while unrelated sessions run in parallel", async () => {
        const streams = new Map<string, ReturnType<typeof streamResponse>>();
        const requests: { body: { modelId: string }; sessionId: string }[] = [];
        const responses: ReturnType<typeof deferred<Response>>[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                const sessionId = url.pathname.split("/")[2] ?? "";
                if (url.pathname === "/events/live") {
                    const stream = streamResponse();
                    streams.set("live", stream);
                    return Promise.resolve(stream.response);
                }
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                const pending = deferred<Response>();
                responses.push(pending);
                requests.push({
                    body: JSON.parse(String(init?.body)) as { modelId: string },
                    sessionId,
                });
                return pending.promise;
            },
            randomValues,
            token: "secret",
        });
        const one = rig.connectSession({ onChange: () => undefined, sessionId: "one" });
        const two = rig.connectSession({ onChange: () => undefined, sessionId: "two" });
        try {
            rig.switchModel("one", "model-a");
            rig.switchModel("one", "model-b");
            rig.switchModel("two", "model-c");
            await settle();

            expect(requests).toEqual([
                { body: expect.objectContaining({ modelId: "model-a" }), sessionId: "one" },
                { body: expect.objectContaining({ modelId: "model-c" }), sessionId: "two" },
            ]);

            responses[0]?.resolve(
                new Response(JSON.stringify({ session: { lastEventId: "one-next" } }), {
                    status: 200,
                }),
            );
            await settle();
            expect(requests.at(-1)).toEqual({
                body: expect.objectContaining({ modelId: "model-b" }),
                sessionId: "one",
            });
        } finally {
            one.close();
            two.close();
            rig.close();
        }
    });

    it("rolls back a rejected change and reapplies the later optimistic overlay", async () => {
        const stream = streamResponse();
        const second = deferred<Response>();
        let mutations = 0;
        const deltas: ChatDelta[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                mutations += 1;
                return mutations === 1
                    ? Promise.resolve(
                          new Response(JSON.stringify({ error: "That model is unavailable." }), {
                              status: 400,
                          }),
                      )
                    : second.promise;
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            onDelta: (delta) => deltas.push(delta),
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            const rejected = rig.switchModel("session-1", "model-a");
            rig.switchModel("session-1", "model-b");
            expect(connection.session().modelId).toBe("model-b");
            await settle();

            expect(connection.session().modelId).toBe("model-b");
            expect(deltas).toContainEqual({
                action: "switch_model",
                message: "That model is unavailable.",
                mutationId: rejected,
                type: "mutation_rejected",
            });
            expect(mutations).toBe(2);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps a pending mutation across a stream reconnect", async () => {
        const streams: ReturnType<typeof streamResponse>[] = [];
        const response = deferred<Response>();
        let mutationCalls = 0;
        // What the daemon reports when the client bootstraps the session again.
        let stateModel = "old-model";
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") {
                    const stream = streamResponse();
                    streams.push(stream);
                    return Promise.resolve(stream.response);
                }
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState(stateModel)), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                mutationCalls += 1;
                return response.promise;
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            await settle();
            streams[0]?.write(liveHello());
            await settle();
            rig.switchModel("session-1", "new-model");
            streams[0]?.close();
            await settle();

            expect(streams).toHaveLength(2);
            expect(connection.session().modelId).toBe("new-model");
            expect(mutationCalls).toBe(1);
            response.resolve(
                new Response(JSON.stringify({ session: { lastEventId: "accepted" } }), {
                    status: 200,
                }),
            );
            await settle();
            expect(connection.session().modelId).toBe("new-model");
            stateModel = "authoritative-model";
            streams[1]?.write(liveHello());
            await settle();
            // A completed mutation is committed, not retained as an overlay
            // that can overwrite a later recovery snapshot forever.
            expect(connection.session().modelId).toBe("authoritative-model");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("ignores a late failure from a superseded session bootstrap", async () => {
        const streams: ReturnType<typeof streamResponse>[] = [];
        const states = [deferred<Response>(), deferred<Response>()];
        const errors: unknown[] = [];
        let stateRequests = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") {
                    const stream = streamResponse();
                    streams.push(stream);
                    return Promise.resolve(stream.response);
                }
                if (url.pathname.endsWith("/state")) {
                    return states[stateRequests++]!.promise;
                }
                return Promise.resolve(new Response("{}", { status: 500 }));
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            onError: (error) => errors.push(error),
            sessionId: "session-1",
        });
        try {
            await settle();
            streams[0]?.write(liveHello());
            await settle();
            expect(stateRequests).toBe(1);

            streams[0]?.close();
            await settle();
            streams[1]?.write(
                liveHello("01900000-0000-7000-8000-000000000099", {
                    gap: true,
                    resumed: true,
                }),
            );
            await settle();
            expect(stateRequests).toBe(2);

            states[1]!.resolve(
                new Response(JSON.stringify(sessionState("recovered-model")), { status: 200 }),
            );
            await settle();
            expect(connection.session()).toMatchObject({
                connection: "live",
                modelId: "recovered-model",
            });

            states[0]!.reject(new Error("stale bootstrap failed"));
            await settle();
            expect(connection.session()).toMatchObject({
                connection: "live",
                modelId: "recovered-model",
            });
            expect(errors).toEqual([]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("ignores a late failure from a superseded catalog bootstrap", async () => {
        const streams: ReturnType<typeof streamResponse>[] = [];
        const catalogs = [deferred<Response>(), deferred<Response>()];
        const errors: unknown[] = [];
        let catalogRequests = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") {
                    const stream = streamResponse();
                    streams.push(stream);
                    return Promise.resolve(stream.response);
                }
                if (url.pathname === "/catalog") {
                    return catalogs[catalogRequests++]!.promise;
                }
                return Promise.resolve(new Response("{}", { status: 500 }));
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectGroups({
            onChange: () => undefined,
            onError: (error) => errors.push(error),
        });
        try {
            await settle();
            streams[0]?.write(liveHello());
            await settle();
            expect(catalogRequests).toBe(1);

            streams[0]?.close();
            await settle();
            streams[1]?.write(
                liveHello("01900000-0000-7000-8000-000000000099", {
                    gap: true,
                    resumed: true,
                }),
            );
            await settle();
            expect(catalogRequests).toBe(2);

            const recovered = groupsCatalog();
            catalogs[1]!.resolve(
                new Response(
                    JSON.stringify({
                        ...recovered,
                        projects: recovered.projects.map((project) => ({
                            ...project,
                            name: "Recovered",
                        })),
                    }),
                    { status: 200 },
                ),
            );
            await settle();
            expect(connection.state().connection).toBe("live");
            expect(connection.projects()[0]?.name).toBe("Recovered");

            catalogs[0]!.reject(new Error("stale catalog failed"));
            await settle();
            expect(connection.state().connection).toBe("live");
            expect(connection.projects()[0]?.name).toBe("Recovered");
            expect(errors).toEqual([]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("pages from the held message through the newest turn after a gap", async () => {
        const streams: ReturnType<typeof streamResponse>[] = [];
        const requested: URL[] = [];
        let stateRequests = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                requested.push(url);
                if (url.pathname === "/events/live") {
                    const stream = streamResponse();
                    streams.push(stream);
                    return Promise.resolve(stream.response);
                }
                if (url.pathname.endsWith("/state")) {
                    stateRequests += 1;
                    const state =
                        stateRequests === 1
                            ? sessionStateWithTranscript(transcriptWindow([1], true))
                            : sessionStateWithTranscript(transcriptWindow([1, 2], false), true);
                    return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
                }
                if (url.pathname.endsWith("/transcript")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(transcriptWindow([2, 3], true)), {
                            status: 200,
                        }),
                    );
                }
                return Promise.resolve(new Response("{}", { status: 500 }));
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            await settle();
            streams[0]?.write(liveHello());
            await settle();
            expect(
                connection.elements().filter((element) => element.kind === "user_message"),
            ).toHaveLength(1);

            streams[0]?.close();
            await settle();
            streams[1]?.write(
                liveHello("01900000-0000-7000-8000-000000000099", {
                    gap: true,
                    resumed: true,
                }),
            );
            await settle();

            const messages = connection
                .elements()
                .filter((element) => element.kind === "user_message");
            expect(messages).toHaveLength(3);
            expect(JSON.stringify(messages)).toContain("Message 3");
            expect(
                requested.some(
                    (url) =>
                        url.pathname === "/sessions/session-1/transcript" &&
                        url.searchParams.get("after") === "01900000-0000-7000-8000-000000000002",
                ),
            ).toBe(true);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("aborts retry work and stops publishing when closed", async () => {
        const stream = streamResponse();
        const retry = deferred<void>();
        let mutationCalls = 0;
        let renders = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                mutationCalls += 1;
                return Promise.reject(new TypeError("offline"));
            },
            randomValues,
            token: "secret",
            wait: () => retry.promise,
        });
        const connection = rig.connectSession({
            onChange: () => {
                renders += 1;
            },
            sessionId: "session-1",
        });
        stream.write(liveHello());
        await settle();
        rig.sendMessage("session-1", "Pending");
        await settle();
        const beforeClose = renders;

        rig.close();
        retry.resolve();
        await settle();

        expect(mutationCalls).toBe(1);
        expect(renders).toBe(beforeClose);
        expect(() => rig.sendMessage("session-1", "Too late")).toThrow(/closed/u);
        connection.close();
    });

    it("acknowledges an optimistic message from its stream echo", async () => {
        const stream = streamResponse();
        const response = deferred<Response>();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(
                        new Response(JSON.stringify(sessionState()), { status: 200 }),
                    );
                }
                return response.promise;
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(liveHello());
            await settle();
            const mutationId = rig.sendMessage("session-1", "Echoed");
            stream.write(
                event("message_submitted", {
                    delivery: "run",
                    displayText: "Echoed",
                    message: {
                        blocks: [{ text: "Echoed", type: "text" }],
                        id: mutationId,
                        role: "user",
                    },
                    mutationId,
                    runId: "run-1",
                }),
            );
            await settle();

            expect(
                connection
                    .elements()
                    .filter(
                        (element) =>
                            element.kind === "user_message" && element.messageId === mutationId,
                    ),
            ).toHaveLength(1);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("renames a group immediately and sends its authoritative version", async () => {
        const stream = streamResponse();
        let mutationRequest: { init?: RequestInit; url: URL } | undefined;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(JSON.stringify(groupsCatalog()), { status: 200 }),
                    );
                }
                mutationRequest = { ...(init === undefined ? {} : { init }), url };
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            project: { id: "project-1", name: "After (2)", version: 4 },
                        }),
                        { status: 200 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            // The stream opens first; the catalog is fetched in response to that.
            stream.write(liveHello());
            await settle();
            const mutationId = rig.renameGroup(
                { kind: "project", projectId: "project-1" },
                "After",
            );

            expect(connection.projects()[0]?.name).toBe("After");
            expect(mutationRequest?.url.pathname).toBe("/projects/project-1");
            expect((mutationRequest?.init?.headers as Record<string, string>)["if-match"]).toBe(
                '"3"',
            );
            expect(JSON.parse(String(mutationRequest?.init?.body))).toEqual({
                mutationId,
                name: "After",
            });
            await settle();
            expect(connection.projects()[0]?.name).toBe("After (2)");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("rolls back an optimistic workspace when creation returns an invalid entity", async () => {
        const stream = streamResponse();
        const rejections: MutationRejectedDelta[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(JSON.stringify(groupsCatalog()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                const body = JSON.parse(String(init?.body)) as { id: string };
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            workspace: {
                                ...daemonWorkspace(body.id),
                                error: "x".repeat(501),
                                status: "failed",
                            },
                        }),
                        { status: 200 },
                    ),
                );
            },
            onMutationRejected: (rejection) => rejections.push(rejection),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            const mutationId = rig.createWorkspace({
                name: "Feature",
                projectId: "project-1",
            });
            expect(connection.projects()[0]?.workspaces.map((workspace) => workspace.id)).toEqual([
                mutationId,
            ]);

            await settle();
            expect(connection.projects()[0]?.workspaces).toEqual([]);
            expect(rejections).toContainEqual({
                action: "create_workspace",
                message: "Rig returned an invalid workspace response.",
                mutationId,
                type: "mutation_rejected",
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("tracks a managed project from optimistic clone through the authoritative response", async () => {
        const stream = streamResponse();
        let request:
            | { body: Record<string, unknown>; headers: Record<string, string>; path: string }
            | undefined;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(JSON.stringify(groupsCatalog()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                request = {
                    body,
                    headers: Object.fromEntries(new Headers(init?.headers)),
                    path: url.pathname,
                };
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            project: {
                                ...groupsCatalog().projects[0],
                                id: body.projectId,
                                initializationAttempt: 0,
                                initializationStatus: "ready",
                                name: body.name,
                                nameSource: "user",
                                path: "/home/Projects/Remote",
                                presence: "present",
                                remoteSource: body.source,
                                requiredSecretKind: "github",
                                storageKey: "remote",
                                version: 1,
                            },
                        }),
                        { status: 202 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            const projectId = rig.projects.clone({
                identity: "asteveprofile",
                name: "Remote",
                secret: { kind: "github" },
                source: { kind: "github", repository: "slopus/rig" },
            });
            expect(connection.projects().find((project) => project.id === projectId)).toMatchObject(
                {
                    initializationStatus: "initializing",
                    presence: "missing",
                    remoteSource: { kind: "github", repository: "slopus/rig" },
                },
            );

            await settle();
            expect(request).toEqual({
                body: {
                    identity: "asteveprofile",
                    name: "Remote",
                    projectId,
                    secret: { kind: "github" },
                    source: { kind: "github", repository: "slopus/rig" },
                },
                headers: expect.objectContaining({ "x-rig-mutation-id": projectId }),
                path: "/projects/clone",
            });
            expect(connection.projects().find((project) => project.id === projectId)).toMatchObject(
                {
                    initializationStatus: "ready",
                    path: "/home/Projects/Remote",
                    presence: "present",
                },
            );
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("refreshes GitHub authentication for messages in a managed remote project", async () => {
        const catalog = groupsCatalog();
        catalog.projects = catalog.projects.map((project) => ({
            ...project,
            createdBy: {
                instanceId: "aremoteinstance0000000001",
                profileId: "asteveprofile",
            },
            requiredSecretKind: "github" as const,
        }));
        catalog.sessions = [{ ...catalogSession(), profileId: "asteveprofile" }];
        let messageBody: Record<string, unknown> | undefined;
        const rig = connectRig({
            endpoint: "http://daemon.test/p2p/peers/secondary/api",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/catalog")) {
                    return Promise.resolve(new Response(JSON.stringify(catalog), { status: 200 }));
                }
                if (url.pathname.endsWith("/git/watch")) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                if (url.pathname.endsWith("/messages")) {
                    messageBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                eventId: "event-remote-message",
                                runId: "run-remote-message",
                                sessionId: "session-1",
                            }),
                            { status: 202 },
                        ),
                    );
                }
                return Promise.resolve(new Response("{}", { status: 200 }));
            },
            randomValues,
            token: "secret",
        });
        try {
            rig.sendMessage("session-1", "Push the branch");
            await settle();

            expect(messageBody).toMatchObject({
                gitSecret: { kind: "github" },
                identity: "asteveprofile",
                text: "Push the branch",
            });
        } finally {
            rig.close();
        }
    });

    it("surfaces the daemon error when workspace creation conflicts without an entity", async () => {
        const stream = streamResponse();
        const rejections: MutationRejectedDelta[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(JSON.stringify(groupsCatalog()), { status: 200 }),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                return Promise.resolve(
                    new Response(JSON.stringify({ error: "That workspace already exists." }), {
                        status: 409,
                    }),
                );
            },
            onMutationRejected: (rejection) => rejections.push(rejection),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            const mutationId = rig.createWorkspace({
                name: "Feature",
                projectId: "project-1",
            });
            await settle();

            expect(connection.projects()[0]?.workspaces).toEqual([]);
            expect(rejections).toContainEqual({
                action: "create_workspace",
                message: "That workspace already exists.",
                mutationId,
                type: "mutation_rejected",
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("restores a workspace rename when the update response is schema-invalid", async () => {
        const stream = streamResponse();
        const rejections: MutationRejectedDelta[] = [];
        const workspace = daemonWorkspace("workspace-1");
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                ...groupsCatalog(),
                                workspaces: [workspace],
                            }),
                            { status: 200 },
                        ),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            workspace: {
                                ...workspace,
                                name: "Wrong",
                                unexpected: true,
                                version: 2,
                            },
                        }),
                        { status: 409 },
                    ),
                );
            },
            onMutationRejected: (rejection) => rejections.push(rejection),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            const mutationId = rig.renameGroup(
                { kind: "workspace", projectId: "project-1", workspaceId: workspace.id },
                "Renamed",
            );
            expect(connection.projects()[0]?.workspaces[0]?.name).toBe("Renamed");

            await settle();
            expect(connection.projects()[0]?.workspaces).toHaveLength(1);
            expect(connection.projects()[0]?.workspaces[0]?.name).toBe("Feature");
            expect(rejections).toContainEqual({
                action: "rename_group",
                message: "Rig returned an invalid workspace response.",
                mutationId,
                type: "mutation_rejected",
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("surfaces the daemon error when a renamed workspace no longer exists", async () => {
        const stream = streamResponse();
        const rejections: MutationRejectedDelta[] = [];
        const workspace = daemonWorkspace("workspace-1");
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({ ...groupsCatalog(), workspaces: [workspace] }),
                            { status: 200 },
                        ),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                return Promise.resolve(
                    new Response(JSON.stringify({ error: "That workspace no longer exists." }), {
                        status: 409,
                    }),
                );
            },
            onMutationRejected: (rejection) => rejections.push(rejection),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            const mutationId = rig.renameGroup(
                { kind: "workspace", projectId: "project-1", workspaceId: workspace.id },
                "Renamed",
            );
            await settle();

            expect(connection.projects()[0]?.workspaces).toHaveLength(1);
            expect(connection.projects()[0]?.workspaces[0]?.name).toBe("Feature");
            expect(rejections).toContainEqual({
                action: "rename_group",
                message: "That workspace no longer exists.",
                mutationId,
                type: "mutation_rejected",
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps an archive committed when its 409 body has no workspace entity", async () => {
        const stream = streamResponse();
        const rejections: MutationRejectedDelta[] = [];
        const workspace = daemonWorkspace("workspace-1");
        let archiveRequests = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({ ...groupsCatalog(), workspaces: [workspace] }),
                            { status: 200 },
                        ),
                    );
                }
                if (url.pathname === "/git/watch") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                    );
                }
                archiveRequests += 1;
                return Promise.resolve(
                    new Response(JSON.stringify({ error: "The workspace is already archived." }), {
                        status: 409,
                    }),
                );
            },
            onMutationRejected: (rejection) => rejections.push(rejection),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            rig.archiveWorkspace("project-1", workspace.id);
            expect(connection.projects()[0]?.workspaces).toEqual([]);
            await settle();

            expect(connection.projects()[0]?.workspaces).toEqual([]);
            expect(archiveRequests).toBe(1);
            expect(rejections).toEqual([]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("skips an invalid live workspace entity and keeps following the stream", async () => {
        const stream = streamResponse();
        const errors: unknown[] = [];
        const workspace = daemonWorkspace("workspace-1");
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                ...groupsCatalog(),
                                workspaces: [workspace],
                            }),
                            { status: 200 },
                        ),
                    );
                }
                return Promise.resolve(
                    new Response(JSON.stringify({ snapshots: [] }), { status: 200 }),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({
            onChange: () => undefined,
            onError: (error) => errors.push(error),
        });
        try {
            stream.write(liveHello());
            await settle();

            stream.write(
                globalEvent(
                    "workspace_updated",
                    {
                        workspace: {
                            ...workspace,
                            error: "x".repeat(501),
                            status: "failed",
                            version: 2,
                        },
                    },
                    { projectId: "project-1", workspaceId: workspace.id },
                ),
            );
            stream.write(
                globalEvent(
                    "workspace_updated",
                    {
                        workspace: {
                            ...workspace,
                            error: "Authoritative failure.",
                            status: "failed",
                            version: 3,
                        },
                    },
                    { projectId: "project-1", workspaceId: workspace.id },
                    "01900000-0000-7000-8000-000000000004",
                ),
            );
            await settle();

            expect(connection.projects()[0]?.workspaces[0]).toMatchObject({
                error: "Authoritative failure.",
                status: "failed",
            });
            expect(connection.state().connection).toBe("live");
            expect(errors).toEqual([
                expect.objectContaining({
                    message: "Rig ignored an invalid live workspace update.",
                }),
            ]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("rejects an invalid workspace catalog before it reaches the projection", async () => {
        const stream = streamResponse();
        const errors: unknown[] = [];
        const reported = deferred<unknown>();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            ...groupsCatalog(),
                            workspaces: [
                                {
                                    ...daemonWorkspace("workspace-1"),
                                    unexpected: true,
                                },
                            ],
                        }),
                        { status: 200 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({
            onChange: () => undefined,
            onError: (error) => {
                errors.push(error);
                reported.resolve(error);
            },
        });
        try {
            stream.write(liveHello());
            await reported.promise;

            expect(connection.projects()).toEqual([]);
            expect(connection.state().connection).toBe("closed");
            expect(errors).toEqual([
                expect.objectContaining({ message: "Rig returned an invalid workspace catalog." }),
            ]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("reports protocol incompatibility before validating newer workspace fields", async () => {
        const stream = streamResponse();
        const reported = deferred<unknown>();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            ...groupsCatalog(),
                            protocolVersion: 999,
                            workspaces: [
                                {
                                    ...daemonWorkspace("workspace-1"),
                                    futureField: true,
                                },
                            ],
                        }),
                        { status: 200 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({
            onChange: () => undefined,
            onError: (error) => reported.resolve(error),
        });
        try {
            stream.write(liveHello());
            const error = await reported.promise;

            expect(error).toEqual(
                expect.objectContaining({
                    message: `The Rig server protocol is version 999, but this rig-connect build supports at most version ${String(MAXIMUM_RIG_PROTOCOL_VERSION)}.`,
                }),
            );
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("shows one workspace for one creation, and never brings an archived one back", async () => {
        const stream = streamResponse();
        let catalogWorkspaces: unknown[] = [];
        const createResponse = deferred<Response>();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                ...groupsCatalog(),
                                workspaces: catalogWorkspaces,
                            }),
                            { status: 200 },
                        ),
                    );
                }
                if (url.pathname.endsWith("/archive")) {
                    const workspaceId = url.pathname.split("/").at(-2) as string;
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                workspace: {
                                    ...daemonWorkspace(workspaceId),
                                    status: "archiving",
                                    version: 2,
                                },
                            }),
                            { status: 200 },
                        ),
                    );
                }
                // Held, because the stream is what usually announces the new
                // workspace first; the answer to the request only confirms it.
                return createResponse.promise;
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        const workspaceIds = () => connection.projects()[0]?.workspaces.map((item) => item.id);
        try {
            stream.write(liveHello());
            await settle();

            const mutationId = rig.createWorkspace({
                baseRef: "main",
                name: "Feature",
                projectId: "project-1",
            });
            // One row appears at once, before the daemon has answered anything,
            // and it already carries the identity the daemon will report.
            expect(workspaceIds()).toEqual([mutationId]);
            const created = daemonWorkspace(mutationId);

            await settle();
            stream.write(
                globalEvent(
                    "workspace_created",
                    { mutationId, workspace: created },
                    { projectId: "project-1", workspaceId: created.id },
                ),
            );
            await settle();
            // The prediction became the real workspace rather than a second row.
            expect(workspaceIds()).toEqual([created.id]);

            createResponse.resolve(
                new Response(JSON.stringify({ workspace: created }), { status: 200 }),
            );
            await settle();
            expect(workspaceIds()).toEqual([created.id]);

            rig.archiveWorkspace("project-1", created.id);
            expect(workspaceIds()).toEqual([]);

            // The daemon is still finishing the archive, so it keeps describing the
            // workspace. The decision was the user's, and it stands.
            await settle();
            stream.write(
                globalEvent(
                    "workspace_updated",
                    { workspace: { ...created, status: "archiving", version: 2 } },
                    { projectId: "project-1", workspaceId: created.id },
                    "01900000-0000-7000-8000-000000000004",
                ),
            );
            await settle();
            expect(workspaceIds()).toEqual([]);

            // Even a reconnect whose snapshot still lists the workspace as present.
            catalogWorkspaces = [{ ...created, version: 3 }];
            stream.write(liveHello("01900000-0000-7000-8000-000000000005", { gap: true }));
            await settle();
            expect(workspaceIds()).toEqual([]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps one workspace when a snapshot answers a create the response has not", async () => {
        const stream = streamResponse();
        let catalogWorkspaces: unknown[] = [];
        const createResponse = deferred<Response>();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                ...groupsCatalog(),
                                workspaces: catalogWorkspaces,
                            }),
                            { status: 200 },
                        ),
                    );
                }
                if (url.pathname === "/projects/project-1/workspaces") {
                    return createResponse.promise;
                }
                return Promise.resolve(new Response("{}", { status: 200 }));
            },
            randomValues,
            token: "secret",
        });
        const frames: string[][] = [];
        const connection = rig.connectGroups({
            onChange: (projects) => {
                frames.push(projects[0]?.workspaces.map((item) => item.id) ?? []);
            },
        });
        const workspaceIds = () => connection.projects()[0]?.workspaces.map((item) => item.id);
        try {
            stream.write(liveHello());
            await settle();

            const workspaceId = rig.createWorkspace({
                baseRef: "main",
                name: "Feature",
                projectId: "project-1",
            });
            const created = daemonWorkspace(workspaceId);
            await settle();
            expect(workspaceIds()).toEqual([workspaceId]);

            // The daemon has created it and a reconnect snapshot now names it,
            // while the create request is still waiting for its answer. A
            // snapshot names no mutation, so the identity is the only thing that
            // ties the prediction and the answer together.
            catalogWorkspaces = [created];
            stream.write(liveHello("01900000-0000-7000-8000-000000000005", { gap: true }));
            await settle();
            expect(workspaceIds()).toEqual([workspaceId]);

            createResponse.resolve(
                new Response(JSON.stringify({ workspace: created }), { status: 200 }),
            );
            await settle();
            expect(workspaceIds()).toEqual([workspaceId]);
            expect(frames.every((frame) => frame.length <= 1)).toBe(true);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("recovers the shared profile cache after a transient read failure", async () => {
        const stream = streamResponse();
        const profile = {
            createdAt: 1,
            email: "steve@example.test",
            id: "aprofile000000000000000001",
            name: "Steve",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 1,
            version: 1,
        };
        let profileReads = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/profiles") {
                    profileReads += 1;
                    return Promise.resolve(
                        profileReads === 1
                            ? new Response(JSON.stringify({ error: "temporary" }), { status: 503 })
                            : new Response(JSON.stringify({ profiles: [profile] }), {
                                  status: 200,
                              }),
                    );
                }
                return Promise.resolve(new Response("{}", { status: 404 }));
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const changes: (readonly (typeof profile)[])[] = [];
        const errors: unknown[] = [];
        const connection = rig.connectProfiles({
            onChange: (profiles) => changes.push(profiles),
            onError: (error) => errors.push(error),
        });
        try {
            stream.write(liveHello());
            await settle();

            expect(profileReads).toBe(2);
            expect(errors).toHaveLength(1);
            expect(connection.profiles()).toEqual([profile]);
            expect(changes).toEqual([[profile]]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("resolves identities when a session opens after profiles already loaded", async () => {
        const stream = streamResponse();
        const profile = {
            createdAt: 1,
            email: "steve@example.test",
            id: "aprofile000000000000000001",
            name: "Steve",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 1,
            version: 1,
        };
        const state = sessionState();
        state.session!.snapshot.messages = [
            {
                blocks: [{ text: "Hi from Steve", type: "text" }],
                id: "message-profiled",
                identity: profile.id,
                role: "user",
            },
        ];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/profiles") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ profiles: [profile] }), { status: 200 }),
                    );
                }
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
                }
                return Promise.resolve(new Response("{}", { status: 404 }));
            },
            randomValues,
            token: "secret",
        });
        const profiles = rig.connectProfiles({ onChange: () => undefined });
        let session: ReturnType<typeof rig.connectSession> | undefined;
        try {
            stream.write(liveHello());
            await settle();
            expect(profiles.profiles()).toEqual([profile]);

            session = rig.connectSession({
                onChange: () => undefined,
                sessionId: "session-1",
            });
            await settle();

            expect(session.elements()[0]).toMatchObject({
                identity: profile.id,
                kind: "user_message",
                profile,
                text: "Hi from Steve",
            });
        } finally {
            session?.close();
            profiles.close();
            rig.close();
        }
    });

    it("resolves an identity first introduced by an earlier transcript page", async () => {
        const stream = streamResponse();
        const profile = {
            createdAt: 1,
            email: "steve@example.test",
            id: "aprofile000000000000000001",
            name: "Steve",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 1,
            version: 1,
        };
        const state = sessionStateWithTranscript(transcriptWindow([2], false));
        const earlier: SessionTranscriptWindow = {
            complete: true,
            messageCreatedAt: { "message-profiled": 100 },
            messageEventId: {
                "message-profiled": "01900000-0000-7000-8000-000000000001",
            },
            messages: [
                {
                    blocks: [{ text: "Hi from Steve", type: "text" }],
                    id: "message-profiled",
                    identity: profile.id,
                    role: "user",
                },
            ],
            turns: [
                {
                    endedAt: 150,
                    messageIds: ["message-profiled"],
                    outcome: "success",
                    runId: "run-1",
                    startedAt: 100,
                },
            ],
        };
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/profiles") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ profiles: [profile] }), { status: 200 }),
                    );
                }
                if (url.pathname.endsWith("/state")) {
                    return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
                }
                if (url.pathname.endsWith("/transcript")) {
                    return Promise.resolve(new Response(JSON.stringify(earlier), { status: 200 }));
                }
                return Promise.resolve(new Response("{}", { status: 404 }));
            },
            randomValues,
            token: "secret",
        });
        const session = rig.connectSession({ onChange: () => undefined, sessionId: "session-1" });
        try {
            stream.write(liveHello());
            await settle();

            const token = session.session().loadMoreToken;
            if (token === undefined) throw new Error("Expected an earlier-page token.");
            session.loadMore(token);
            await settle();

            expect(session.elements()).toContainEqual(
                expect.objectContaining({
                    identity: profile.id,
                    kind: "user_message",
                    profile,
                    text: "Hi from Steve",
                }),
            );
        } finally {
            session.close();
            rig.close();
        }
    });

    it("does not publish a profile mutation as a complete catalog before its first load", async () => {
        const stream = streamResponse();
        const catalog = deferred<Response>();
        const existing = {
            createdAt: 1,
            email: "existing@example.test",
            id: "aprofile000000000000000001",
            name: "Existing",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 1,
            version: 1,
        };
        const created = {
            createdAt: 2,
            email: "created@example.test",
            id: "aprofile000000000000000002",
            name: "Created",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 2,
            version: 1,
        };
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/profiles" && init?.method === undefined) {
                    return catalog.promise;
                }
                if (url.pathname === "/profiles" && init?.method === "POST") {
                    return Promise.resolve(
                        new Response(JSON.stringify({ profile: created }), { status: 200 }),
                    );
                }
                return Promise.resolve(new Response("{}", { status: 404 }));
            },
            randomValues,
            token: "secret",
        });
        const changes: (readonly (typeof existing)[])[] = [];
        const connection = rig.connectProfiles({ onChange: (profiles) => changes.push(profiles) });
        try {
            stream.write(liveHello());
            await settle();

            await expect(
                rig.createProfile({ email: "created@example.test", name: "Created" }),
            ).resolves.toEqual(created);
            expect(connection.profiles()).toEqual([]);
            expect(changes).toEqual([]);

            catalog.resolve(
                new Response(JSON.stringify({ profiles: [existing, created] }), { status: 200 }),
            );
            await settle();

            expect(connection.profiles()).toEqual([existing, created]);
            expect(changes).toEqual([[existing, created]]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps the newest profile version when stale lists and mutations finish last", async () => {
        const stream = streamResponse();
        const staleList = deferred<Response>();
        const staleMutation = deferred<Response>();
        const profile = (version: number, name: string) => ({
            createdAt: 1,
            email: "steve@example.test",
            id: "aprofile000000000000000001",
            name,
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: version,
            version,
        });
        let profileReads = 0;
        let profileUpdates = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, _init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return Promise.resolve(stream.response);
                if (url.pathname === "/profiles") {
                    profileReads += 1;
                    return profileReads === 1
                        ? Promise.resolve(
                              new Response(JSON.stringify({ profiles: [profile(1, "Original")] }), {
                                  status: 200,
                              }),
                          )
                        : staleList.promise;
                }
                if (url.pathname.endsWith("/aprofile000000000000000001")) {
                    profileUpdates += 1;
                    if (profileUpdates === 1) {
                        return Promise.resolve(
                            new Response(JSON.stringify({ profile: profile(3, "Current") }), {
                                status: 200,
                            }),
                        );
                    }
                    if (profileUpdates === 2) return staleMutation.promise;
                    return Promise.resolve(
                        new Response(JSON.stringify({ profile: profile(5, "Newest") }), {
                            status: 200,
                        }),
                    );
                }
                return Promise.resolve(new Response("{}", { status: 404 }));
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectProfiles({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            expect(connection.profiles()).toEqual([profile(1, "Original")]);

            const pendingList = rig.listProfiles();
            await settle();
            await expect(
                rig.updateProfile("aprofile000000000000000001", { name: "Current" }),
            ).resolves.toEqual(profile(3, "Current"));
            expect(connection.profiles()).toEqual([profile(3, "Current")]);

            staleList.resolve(
                new Response(JSON.stringify({ profiles: [profile(2, "Stale list")] }), {
                    status: 200,
                }),
            );
            await expect(pendingList).resolves.toEqual([profile(2, "Stale list")]);
            expect(connection.profiles()).toEqual([profile(3, "Current")]);

            const pendingMutation = rig.updateProfile("aprofile000000000000000001", {
                name: "Stale mutation",
            });
            await settle();
            await expect(
                rig.updateProfile("aprofile000000000000000001", { name: "Newest" }),
            ).resolves.toEqual(profile(5, "Newest"));
            expect(connection.profiles()).toEqual([profile(5, "Newest")]);

            staleMutation.resolve(
                new Response(JSON.stringify({ profile: profile(4, "Stale mutation") }), {
                    status: 200,
                }),
            );
            await expect(pendingMutation).resolves.toEqual(profile(4, "Stale mutation"));
            expect(connection.profiles()).toEqual([profile(5, "Newest")]);
        } finally {
            connection.close();
            rig.close();
        }
    });
});

describe("connectRig and chats that finish", () => {
    /** A catalog holding one tracked chat, which is what unread state needs. */
    function catalogWithTrackedSession(): Omit<GlobalStreamHello, "cursor"> {
        return {
            ...groupsCatalog(),
            sessions: [
                {
                    archived: false,
                    createdAt: 1,
                    cwd: "/work",
                    id: "session-1",
                    modelId: "sonnet-5",
                    ownerInstanceId: "alocalinstance00000000001",
                    orderKey: "a",
                    permissionMode: "auto",
                    scope: { kind: "project", projectId: "project-1" },
                    providerId: "claude",
                    status: "idle",
                    titleStatus: "idle",
                    trackUnread: true,
                    updatedAt: 1,
                },
            ],
        };
    }

    function connect(options: {
        catalog?: Omit<GlobalStreamHello, "cursor">;
        onSessionFinished?: (finished: SessionFinished) => void;
        stream: ReturnType<typeof streamResponse>;
        calls?: { init?: RequestInit; url: URL }[];
    }) {
        const catalog = options.catalog ?? catalogWithTrackedSession();
        return connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                options.calls?.push({ ...(init === undefined ? {} : { init }), url });
                if (url.pathname === "/events/live")
                    return Promise.resolve(options.stream.response);
                if (url.pathname === "/catalog") {
                    return Promise.resolve(new Response(JSON.stringify(catalog), { status: 200 }));
                }
                return Promise.resolve(new Response("{}", { status: 200 }));
            },
            randomValues,
            token: "secret",
            ...(options.onSessionFinished === undefined
                ? {}
                : { onSessionFinished: options.onSessionFinished }),
        });
    }

    it("announces a chat that stopped working, without any view being open", async () => {
        const stream = streamResponse();
        const finished: SessionFinished[] = [];
        // No connectSession and no connectGroups: asking for the notification is
        // what loads the catalog it is told from.
        const rig = connect({ onSessionFinished: (item) => finished.push(item), stream });
        try {
            stream.write(liveHello());
            await settle();

            stream.write(
                event("run_finished", { modelLocked: false, runId: "run-1", stopReason: "end" }),
            );
            await settle();

            expect(finished).toEqual([
                {
                    reason: "turn_finished",
                    scope: { kind: "project", projectId: "project-1" },
                    sessionId: "session-1",
                    since: 2,
                },
            ]);
        } finally {
            rig.close();
        }
    });

    it("announces a question once, and does not repeat itself as the run ends", async () => {
        const stream = streamResponse();
        const finished: SessionFinished[] = [];
        const rig = connect({ onSessionFinished: (item) => finished.push(item), stream });
        try {
            stream.write(liveHello());
            await settle();

            stream.write(
                event(
                    "user_input_requested",
                    { questions: [], requestId: "q1" },
                    "01900000-0000-7000-8000-000000000010",
                ),
            );
            stream.write(
                event(
                    "run_finished",
                    { modelLocked: false, runId: "run-1", stopReason: "end" },
                    "01900000-0000-7000-8000-000000000011",
                ),
            );
            await settle();

            // One sound, for the question. The run stopping afterwards does not
            // answer it, so it is not a second thing to be told about.
            expect(finished).toEqual([
                {
                    reason: "attention_needed",
                    scope: { kind: "project", projectId: "project-1" },
                    sessionId: "session-1",
                    since: 2,
                },
            ]);
        } finally {
            rig.close();
        }
    });

    it("stays quiet for a chat Rig does not track, such as a subagent", async () => {
        const stream = streamResponse();
        const finished: SessionFinished[] = [];
        const catalog = catalogWithTrackedSession();
        const rig = connect({
            catalog: {
                ...catalog,
                sessions: [{ ...catalog.sessions[0]!, trackUnread: false }],
            },
            onSessionFinished: (item) => finished.push(item),
            stream,
        });
        try {
            stream.write(liveHello());
            await settle();
            stream.write(
                event("run_finished", { modelLocked: false, runId: "run-1", stopReason: "end" }),
            );
            await settle();

            expect(finished).toEqual([]);
        } finally {
            rig.close();
        }
    });

    it("clears a chat the moment it is marked read, and tells the daemon", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const rig = connect({ calls, stream });
        const groups = rig.connectGroups({ onChange: () => undefined });
        const unreadCount = () => groups.projects()[0]?.unread.count;
        try {
            stream.write(liveHello());
            await settle();
            stream.write(
                event("run_finished", { modelLocked: false, runId: "run-1", stopReason: "end" }),
            );
            await settle();
            expect(unreadCount()).toBe(1);

            rig.markSessionRead("session-1");
            // The badge clears at once rather than after a round trip.
            expect(unreadCount()).toBe(0);
            await settle();

            const readCall = calls.find((call) => call.url.pathname === "/sessions/session-1/read");
            expect(readCall?.init?.method).toBe("POST");
        } finally {
            groups.close();
            rig.close();
        }
    });
});
