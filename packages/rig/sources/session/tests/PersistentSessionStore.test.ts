import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { AgentMessage, CompactionMessage, UserMessage } from "../../agent/types.js";
import {
    createEventIdFactory,
    type ModelCatalog,
    type SessionEvent,
} from "../../protocol/index.js";
import type { GymInferenceRequest } from "../../executor/gym-types.js";
import { defineModel } from "@slopus/rig-execution";
import type {
    InMemorySession,
    PersistedQueuedRun,
    PersistedSessionState,
} from "../InMemorySession.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";
import { TrackedTaskDrain } from "../../utils/TrackedTaskDrain.js";
import type { GitCommandRunner } from "../../git/types.js";

const execFile = promisify(execFileCallback);

describe("PersistentSessionStore", () => {
    it("reserves sessions and durable runs on an initializing workspace without creating runtimes", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const root = await mkdtemp(join(tmpdir(), "rig-initializing-workspace-"));
        const repository = join(root, "project");
        const materialize = deferred<void>();
        let runtimes = 0;
        let store: PersistentSessionStore | undefined;
        try {
            await createGitRepository(repository);
            const projectGit: GitCommandRunner = async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    await materialize.promise;
                }
                const result = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
                return result.stdout.trim();
            };
            store = new PersistentSessionStore({
                createRuntime: () => {
                    runtimes += 1;
                    throw new Error("An initializing workspace must not create a runtime.");
                },
                databasePath,
                projectGit,
                stateDirectory: join(root, "state"),
                workspacesDirectory: join(root, "workspaces"),
            });
            const owner = store.create({ cwd: repository });
            const workspace = await store.createWorkspace(owner.snapshot().projectId, {
                baseRef: "HEAD",
                id: "w6q0tc4rmq9f4a6adczq9eis",
                name: "Waiting",
            });
            if (workspace === undefined) throw new Error("Expected a workspace reservation.");

            expect(workspace.status).toBe("initializing");
            const first = store.createWithId("d044lyyqklbc850un07gpm9v", {
                cwd: workspace.path,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            });
            const second = store.createWithId("l4c1r61a2hedg6f2zrzfwz4w", {
                cwd: workspace.path,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            });
            const firstRun = first.submit({
                clientSubmissionId: "m7ymgv1cqfbjd0pxukc8403w",
                text: "First queued message.",
            });
            const repeatedRun = first.submit({
                clientSubmissionId: "m7ymgv1cqfbjd0pxukc8403w",
                text: "First queued message.",
            });
            const secondRun = second.submit({
                clientSubmissionId: "n3tfnng0rkcw4mxc3nfq4ntc",
                debug: true,
                text: "Second queued message.",
            });

            expect(
                store.createWithId(first.id, {
                    cwd: workspace.path,
                    projectId: workspace.projectId,
                    workspaceId: workspace.id,
                }),
            ).toBe(first);
            expect(repeatedRun).toEqual(firstRun);
            expect(first.snapshot()).toMatchObject({
                status: "queued",
            });
            expect(second.snapshot()).toMatchObject({
                status: "queued",
            });
            expect(first.state().queuedRuns.map((run) => run.runId)).toEqual([firstRun.runId]);
            expect(second.state().queuedRuns.map((run) => run.runId)).toEqual([secondRun.runId]);
            await new Promise<void>((resolve) => setImmediate(resolve));
            await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
            expect(runtimes).toBe(0);
        } finally {
            materialize.resolve();
            store?.close();
            await Promise.all([cleanup(), rm(root, { force: true, recursive: true })]);
        }
    });

    it("restores pending context and rewinds or resets it atomically", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            let store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-pending-context-restore" });
            const sessionId = session.id;
            session.submitContext({ clientSubmissionId: "note-1", text: "First note." });
            session.submitContext({ clientSubmissionId: "note-2", text: "Second note." });
            session.rewind("note-2");
            store.close();

            store = new PersistentSessionStore({ databasePath });
            const restored = store.get(sessionId);
            expect(restored?.state().pendingContextMessages).toMatchObject([
                { message: { id: "note-1" } },
            ]);
            expect(restored?.state().contextMessages).toEqual([]);
            await restored?.reset();
            store.close();

            store = new PersistentSessionStore({ databasePath });
            expect(store.get(sessionId)?.state().pendingContextMessages).toEqual([]);
            expect(store.get(sessionId)?.state().messages).toEqual([]);
            store.close();
        } finally {
            await cleanup();
        }
    });

    it("does not swallow database failures from post-commit observers", () => {
        const failure = Object.assign(new Error("observer database failed"), {
            code: "SQLITE_IOERR",
        });
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            onSessionEvent: () => {
                throw failure;
            },
        });
        try {
            expect(() => store.create({ cwd: "/tmp/rig-observer-database-failure" })).toThrow(
                failure,
            );
        } finally {
            store.close();
        }
    });

    it("replays durable usage written after the persisted summary cursor", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-usage-crash-boundary" });
            const sessionId = session.id;
            store.close();

            const database = new DatabaseSync(databasePath);
            const previous = database
                .prepare("SELECT last_event_id FROM sessions WHERE id = ?")
                .get(sessionId) as { last_event_id: string };
            const eventId = createEventIdFactory({ after: previous.last_event_id })();
            insertSessionEvent(database, sessionId, eventId, "agent_message", {
                message: {
                    blocks: [{ text: "Recovered usage", type: "text" }],
                    id: "agent-after-summary",
                    providerId: "codex",
                    requestedModelId: session.snapshot().modelId,
                    role: "agent",
                    usage: {
                        cacheRead: 3,
                        cacheWrite: 4,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 10,
                        output: 2,
                        totalTokens: 19,
                    },
                },
                runId: "run-after-summary",
            });
            database
                .prepare("UPDATE sessions SET last_event_id = ? WHERE id = ?")
                .run(eventId, sessionId);
            database.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(sessionId)?.usage().groups).toEqual([
                    expect.objectContaining({
                        usage: expect.objectContaining({ totalTokens: 19 }),
                    }),
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("rolls back a message when its turn projection cannot be written", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const initial = new PersistentSessionStore({ databasePath });
            const state = sessionState();
            initial.saveSession(state);
            initial.close();
            const database = new DatabaseSync(databasePath);
            database.exec(`
                CREATE TRIGGER reject_turn_projection
                BEFORE INSERT ON session_turns
                BEGIN
                    SELECT RAISE(ABORT, 'projection failed');
                END
            `);
            database.close();

            const store = new PersistentSessionStore({ databasePath });
            expect(() =>
                store.upsertMessage(state.id, {
                    isPartial: false,
                    message: textUserMessage("message-1", "Do it"),
                    position: 0,
                    runId: "run-1",
                }),
            ).toThrow("projection failed");
            store.close();

            const check = new DatabaseSync(databasePath);
            expect(
                check.prepare("SELECT 1 FROM session_messages WHERE session_id = ?").get(state.id),
            ).toBeUndefined();
            check.close();
        } finally {
            await cleanup();
        }
    });

    it("restores only a bounded resume tail for an old session", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-bounded-events-"));
        const databasePath = join(directory, "sessions.sqlite");
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-bounded-events" });
            const sessionId = session.id;
            store.close();

            const database = new DatabaseSync(databasePath);
            const previous = database
                .prepare("SELECT last_event_id FROM sessions WHERE id = ?")
                .get(sessionId) as { last_event_id: string };
            const createId = createEventIdFactory({ after: previous.last_event_id });
            const oldMessage = textUserMessage("old-message", "Old history");
            const oldSteering = textUserMessage("old-steering", "Steer old history");
            database
                .prepare(
                    "INSERT INTO session_messages (session_id, position, message_id, role, is_partial, run_id, message_json, updated_at_ms) VALUES (?, 0, ?, 'user', 0, 'run-old', ?, ?)",
                )
                .run(sessionId, oldMessage.id, JSON.stringify(oldMessage), 1_700_000_000_000);
            database
                .prepare(
                    "INSERT INTO session_messages (session_id, position, message_id, role, is_partial, run_id, message_json, updated_at_ms) VALUES (?, 1, ?, 'user', 0, 'run-old', ?, ?)",
                )
                .run(sessionId, oldSteering.id, JSON.stringify(oldSteering), 1_700_000_000_000);
            database
                .prepare(
                    "INSERT INTO session_turns (session_id, run_id, first_position) VALUES (?, 'run-old', 0)",
                )
                .run(sessionId);
            insertSessionEvent(database, sessionId, createId(), "message_submitted", {
                delivery: "run",
                displayText: "Old history",
                message: oldMessage,
                runId: "run-old",
            });
            insertSessionEvent(database, sessionId, createId(), "message_submitted", {
                delivery: "steer",
                displayText: "Steer old history",
                message: oldSteering,
                runId: "run-old",
            });
            insertSessionEvent(database, sessionId, createId(), "steering_applied", {
                messageIds: [oldSteering.id],
                runId: "run-old",
            });
            insertSessionEvent(database, sessionId, createId(), "run_finished", {
                modelLocked: false,
                runId: "run-old",
                stopReason: "stop",
            });
            const insert = database.prepare(
                "INSERT INTO session_events (session_id, event_id, type, created_at_ms, data_json) VALUES (?, ?, 'session_updated', ?, ?)",
            );
            let lastEventId = previous.last_event_id;
            database.exec("BEGIN");
            for (let index = 0; index < 5_000; index += 1) {
                lastEventId = createId();
                insert.run(sessionId, lastEventId, 1_700_000_000_000 + index, "{}");
            }
            database
                .prepare("UPDATE sessions SET last_event_id = ? WHERE id = ?")
                .run(lastEventId, sessionId);
            database.exec("COMMIT");
            database.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(sessionId);
                expect(restored?.events.all()).toHaveLength(4_096);
                expect(restored?.events.lastEventId()).toBe(lastEventId);
                expect(restored?.transcriptWindow().turns).toEqual([
                    expect.objectContaining({
                        outcome: "success",
                        runId: "run-old",
                        startedAt: 1_700_000_000_000,
                    }),
                ]);
                expect(restored?.transcriptWindow().messageSteeredAt).toEqual({
                    [oldSteering.id]: 1_700_000_000_000,
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("lists every active session without materializing archived history", () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            for (let index = 0; index < 501; index += 1) {
                store.createWithId(`session-${String(index)}`, {
                    cwd: "/tmp/rig-complete-session-list",
                });
            }
            const archived = store.createWithId("archived-session", {
                cwd: "/tmp/rig-complete-session-list",
            });
            archived.setArchived(true);

            expect(store.listActive()).toHaveLength(501);
            expect(store.list({ limit: 500 })).toHaveLength(500);
            expect(store.listActive().map((session) => session.id)).not.toContain(archived.id);
        } finally {
            store.close();
        }
    });

    it("creates an idempotent persistent session with an integrating client ID", () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const first = store.createWithId("happy-rig-request-1", { cwd: "/tmp/rig-happy" });
            const second = store.createWithId("happy-rig-request-1", { cwd: "/tmp/rig-happy" });

            expect(first.id).toBe("happy-rig-request-1");
            expect(second).toBe(first);
            expect(second.snapshot().cwd).toBe("/tmp/rig-happy");
            // The same identity describing a different session is a mistake, not
            // a retry, so it is refused rather than quietly answered.
            expect(() =>
                store.createWithId("happy-rig-request-1", { cwd: "/tmp/rig-elsewhere" }),
            ).toThrow("another directory");
        } finally {
            store.close();
        }
    });

    it("resumes a durable external function after daemon restart without replaying its call", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const requests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let store: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                return new Response(
                    JSON.stringify(
                        requests.length === 1
                            ? {
                                  content: [
                                      {
                                          arguments: { ticket: 42 },
                                          id: "provider-call-1",
                                          name: "lookup_ticket",
                                          type: "toolCall",
                                      },
                                  ],
                              }
                            : { content: [{ text: "Ticket resolved.", type: "text" }] },
                    ),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const session = store.create({
                cwd: "/tmp/rig-durable-external-tool",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: "gym",
            });
            const submitted = session.submit({
                externalTools: [
                    {
                        description: "Looks up a ticket in the integrating system.",
                        name: "lookup_ticket",
                        parameters: {
                            additionalProperties: false,
                            properties: { ticket: { type: "number" } },
                            required: ["ticket"],
                            type: "object",
                        },
                    },
                ],
                systemPrompt: "Exact integration prompt.",
                text: "Resolve ticket 42.",
            });
            const pending = await waitForExternalToolCall(session);
            expect(requests[0]?.context.systemPrompt).toContain("Exact integration prompt.");
            expect(requests[0]?.context.systemPrompt).toContain(
                "# Runtime model\nModel ID: openai/gym\nProvider ID: gym",
            );
            expect(
                requests[0]?.context.tools?.find((tool) => tool.name === "lookup_ticket"),
            ).toMatchObject({
                description: "Looks up a ticket in the integrating system.",
                name: "lookup_ticket",
                parameters: { required: ["ticket"], type: "object" },
            });

            await store.prepareForShutdown("shutdown");
            store.close();
            store = undefined;

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const restored = store.get(session.id);
            if (restored === undefined) throw new Error("Expected restored session.");
            expect(restored.snapshot()).toMatchObject({
                pendingExternalToolCalls: [{ id: pending.id, status: "pending" }],
                status: "running",
                systemPrompt: "Exact integration prompt.",
            });

            expect(
                restored.resolveExternalToolCall(pending.id, {
                    output: { state: "resolved" },
                    status: "completed",
                }),
            ).toMatchObject({ accepted: true });
            await expect(restored.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1]?.context.messages)).toContain("resolved");
            expect(requests[1]?.context.messages.slice(-2)).toMatchObject([
                {
                    content: [
                        {
                            providerToolCallId: "provider-call-1",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                },
                {
                    providerToolCallId: "provider-call-1",
                    role: "toolResult",
                },
            ]);
            expect(
                restored.resolveExternalToolCall(pending.id, {
                    output: { state: "resolved" },
                    status: "completed",
                }),
            ).toMatchObject({ accepted: false });
        } finally {
            store?.close();
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            await cleanup();
        }
    });

    it("resumes a structured user question after daemon restart without replaying its call", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const requests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let store: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                return new Response(
                    JSON.stringify(
                        requests.length === 1
                            ? {
                                  content: [
                                      {
                                          arguments: {
                                              questions: [
                                                  {
                                                      header: "Database",
                                                      id: "database",
                                                      options: [
                                                          {
                                                              description: "Use PostgreSQL.",
                                                              label: "PostgreSQL",
                                                          },
                                                          {
                                                              description: "Use SQLite.",
                                                              label: "SQLite",
                                                          },
                                                      ],
                                                      question: "Which database should be used?",
                                                  },
                                              ],
                                          },
                                          id: "durable-question-one",
                                          name: "request_user_input",
                                          type: "toolCall",
                                      },
                                      {
                                          arguments: {
                                              questions: [
                                                  {
                                                      header: "Cache",
                                                      id: "cache",
                                                      options: [
                                                          {
                                                              description: "Use Redis.",
                                                              label: "Redis",
                                                          },
                                                          {
                                                              description: "Do not use a cache.",
                                                              label: "None",
                                                          },
                                                      ],
                                                      question: "Which cache should be used?",
                                                  },
                                              ],
                                          },
                                          id: "durable-question-two",
                                          name: "request_user_input",
                                          type: "toolCall",
                                      },
                                  ],
                              }
                            : { content: [{ text: "Question resolved.", type: "text" }] },
                    ),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const session = store.create({
                cwd: "/tmp/rig-durable-user-input",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: "gym",
            });
            const submitted = session.submit({ text: "Choose a database." });
            await waitForPendingUserInputs(session, 2);

            await store.prepareForShutdown("shutdown");
            store.close();
            store = undefined;

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const restored = store.get(session.id);
            if (restored === undefined) throw new Error("Expected restored session.");
            const pendingUserInputs = restored.snapshot().pendingUserInputs;
            const databaseRequestId = pendingUserInputs[0]?.requestId;
            const cacheRequestId = pendingUserInputs[1]?.requestId;
            if (databaseRequestId === undefined || cacheRequestId === undefined) {
                throw new Error("Expected both restored user questions.");
            }
            expect(databaseRequestId).not.toBe(cacheRequestId);
            expect(restored.snapshot()).toMatchObject({
                pendingUserInputs: [
                    { requestId: databaseRequestId },
                    { requestId: cacheRequestId },
                ],
                status: "running",
            });

            const databaseAnswer = { answers: { database: ["PostgreSQL"] } };
            const cacheAnswer = { answers: { cache: ["Redis"] } };
            expect(restored.answerUserInput(cacheRequestId, cacheAnswer)).toBeDefined();
            expect(restored.answerUserInput(databaseRequestId, databaseAnswer)).toBeDefined();
            await expect(restored.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(2);
            expect(requests[1]?.context.messages.slice(-2)).toMatchObject([
                {
                    content: [
                        {
                            text: '{"answers":{"database":{"answers":["PostgreSQL"]}}}',
                            type: "text",
                        },
                    ],
                    role: "toolResult",
                    providerToolCallId: "durable-question-one",
                    toolCallId: databaseRequestId,
                },
                {
                    content: [
                        {
                            text: '{"answers":{"cache":{"answers":["Redis"]}}}',
                            type: "text",
                        },
                    ],
                    role: "toolResult",
                    providerToolCallId: "durable-question-two",
                    toolCallId: cacheRequestId,
                },
            ]);
            expect(restored.answerUserInput(databaseRequestId, databaseAnswer)).toBeDefined();
            expect(() =>
                restored.answerUserInput(databaseRequestId, {
                    answers: { database: ["SQLite"] },
                }),
            ).toThrow("already has a different answer");
        } finally {
            store?.close();
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            await cleanup();
        }
    });

    it("resumes a durable skill request with its configured metadata after restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const requests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let store: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                return new Response(
                    JSON.stringify(
                        requests.length === 1
                            ? {
                                  content: [
                                      {
                                          arguments: { name: "release-check" },
                                          id: "provider-skill-call-1",
                                          name: "read_skill",
                                          type: "toolCall",
                                      },
                                  ],
                              }
                            : { content: [{ text: "Release checked.", type: "text" }] },
                    ),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const session = store.create({
                cwd: "/tmp/rig-durable-skill",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: "gym",
            });
            const submitted = session.submit({
                skills: [
                    {
                        description: "Check a release using integration-owned instructions.",
                        location: "durable",
                        name: "release-check",
                    },
                ],
                systemPrompt: "Exact integration prompt.",
                text: "Use the release-check skill.",
            });
            const pending = await waitForExternalToolCall(session);
            expect(pending).toMatchObject({
                arguments: { name: "release-check" },
                skill: { location: "durable", name: "release-check" },
            });
            expect(requests[0]?.context.systemPrompt).toContain("Exact integration prompt.");
            expect(requests[0]?.context.systemPrompt).toContain("<name>release-check</name>");
            expect(
                requests[0]?.context.tools?.find((tool) => tool.name === "read_skill"),
            ).toMatchObject({ parameters: { required: ["name"], type: "object" } });

            await store.prepareForShutdown("shutdown");
            store.close();
            store = undefined;

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const restored = store.get(session.id);
            if (restored === undefined) throw new Error("Expected restored session.");
            expect(restored.snapshot()).toMatchObject({
                pendingExternalToolCalls: [
                    {
                        id: pending.id,
                        skill: { location: "durable", name: "release-check" },
                        status: "pending",
                    },
                ],
                skills: [{ location: "durable", name: "release-check" }],
                status: "running",
            });

            expect(
                restored.resolveExternalToolCall(pending.id, {
                    output: "# Release check\nDURABLE_SKILL_BODY_SENTINEL",
                    status: "completed",
                }),
            ).toMatchObject({ accepted: true });
            await expect(restored.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1]?.context.messages)).toContain(
                "DURABLE_SKILL_BODY_SENTINEL",
            );
            expect(requests[1]?.context.messages.slice(-2)).toMatchObject([
                {
                    content: [
                        {
                            providerToolCallId: "provider-skill-call-1",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                },
                {
                    providerToolCallId: "provider-skill-call-1",
                    role: "toolResult",
                },
            ]);
        } finally {
            store?.close();
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            await cleanup();
        }
    });

    it("retains a bounded external call history without pruning pending work", () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        const state = sessionState();
        store.saveSession(state);
        try {
            for (let index = 0; index < 1_002; index += 1) {
                store.upsertExternalToolCall({
                    arguments: { index },
                    batchId: `batch-${index}`,
                    consumed: true,
                    createdAt: index,
                    definition: {
                        description: "Looks up a ticket.",
                        name: "lookup_ticket",
                        parameters: { type: "object" },
                    },
                    id: `completed-${index}`,
                    resolution: { output: { index }, status: "completed" },
                    resolvedAt: index,
                    runId: `run-${index}`,
                    sessionId: state.id,
                    status: "completed",
                    toolCallId: `tool-${index}`,
                    toolCallIndex: 0,
                });
            }
            store.upsertExternalToolCall({
                arguments: {},
                batchId: "pending-batch",
                consumed: false,
                createdAt: -1,
                definition: {
                    description: "Waits for a callback.",
                    name: "wait_for_callback",
                    parameters: { type: "object" },
                },
                id: "pending-call",
                runId: "pending-run",
                sessionId: state.id,
                status: "pending",
                toolCallId: "pending-tool",
                toolCallIndex: 0,
            });

            store.pruneExternalToolCalls(state.id, 1_000);

            const calls = store.listExternalToolCalls({ limit: 2_000 });
            expect(calls).toHaveLength(1_001);
            expect(calls.some((call) => call.id === "pending-call")).toBe(true);
            expect(calls.some((call) => call.id === "completed-0")).toBe(false);
            expect(calls.some((call) => call.id === "completed-1001")).toBe(true);
        } finally {
            store.close();
        }
    });

    it("restores appended system prompts after reopening SQLite", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({
                appendSystemPrompt: "Persisted API instructions.",
                cwd: "/tmp/rig-persistent-prompt-test",
            });
            session.update({ appendSystemPrompt: "Updated persisted instructions." });
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(session.id);
                expect(restored?.snapshot().appendSystemPrompt).toBe(
                    "Updated persisted instructions.",
                );
                expect(restored?.requestForSubagent().appendSystemPrompt).toBe(
                    "Updated persisted instructions.",
                );
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("delivers transient inference events live without writing session event rows", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-persistent-session-test" });
            const transient = sessionEvent(session.id, "transient-text", "agent_event", {
                event: { contentIndex: 0, delta: "token", partial: {}, type: "text_delta" },
                runId: "run-1",
            });
            const processChanged = sessionEvent(session.id, "process-changed", "agent_event", {
                event: { running: 1, type: "background_processes_changed" },
                runId: "run-1",
            });
            const compacted = sessionEvent(session.id, "context-compacted", "agent_event", {
                event: {
                    compactionId: "compaction-1",
                    compactedMessageCount: 4,
                    elapsedMs: 25,
                    estimatedTokensAfter: 600,
                    estimatedTokensBefore: 4_200,
                    reason: "threshold",
                    type: "context_compacted",
                },
                runId: "run-1",
            });
            const delivered: SessionEvent[] = [];
            session.events.subscribe((event) => delivered.push(event));

            session.events.append(transient);
            session.events.append(processChanged);
            session.events.append(compacted);

            expect(session.events.since(undefined)?.map((event) => event.id)).toEqual([
                expect.any(String),
                processChanged.id,
                compacted.id,
            ]);
            expect(delivered.map((event) => event.id)).toEqual([
                transient.id,
                processChanged.id,
                compacted.id,
            ]);
            const database = new DatabaseSync(databasePath, { readOnly: true });
            try {
                const rows = database
                    .prepare(
                        "SELECT event_id FROM session_events WHERE session_id = ? ORDER BY seq",
                    )
                    .all(session.id) as Array<{ event_id: string }>;
                expect(rows.map((row) => row.event_id)).toEqual([
                    expect.any(String),
                    processChanged.id,
                    compacted.id,
                ]);
            } finally {
                database.close();
            }
            store.close();
        } finally {
            await cleanup();
        }
    });

    it("restores secret registrations and source-scoped attachments after reopening SQLite", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.registerSecret({
                description: "Service API credentials",
                environment: {
                    SERVICE_REGION: "persisted-region",
                    SERVICE_TOKEN: "persisted-token",
                },
                id: "service",
            });
            store.registerSecret({
                description: "Project service credentials",
                environment: { PROJECT_TOKEN: "persisted-project-token" },
                id: "project-service",
            });
            const session = store.create({
                cwd: "/tmp/rig-secret-session",
                secretIds: ["service"],
            });
            store.attachSecret(session.id, "project-service", "project");
            expect(session.snapshot()).toMatchObject({
                projectSecretIds: ["project-service"],
                secretIds: ["project-service", "service"],
                sessionSecretIds: ["service"],
            });
            expect(session.requestForSubagent()).not.toHaveProperty("secretIds");
            store.close();

            const database = new DatabaseSync(databasePath);
            const sessionRow = database
                .prepare("SELECT secret_ids_json FROM sessions WHERE id = ?")
                .get(session.id) as { secret_ids_json: string };
            const registrationRow = database
                .prepare(
                    "SELECT description, environment_json FROM secret_registrations WHERE id = ?",
                )
                .get("service") as { description: string; environment_json: string };
            expect(sessionRow.secret_ids_json).toBe('["service"]');
            expect(registrationRow.description).toBe("Service API credentials");
            expect(JSON.parse(registrationRow.environment_json)).toEqual({
                SERVICE_REGION: "persisted-region",
                SERVICE_TOKEN: "persisted-token",
            });
            database.close();

            let restoredEnvironment: NodeJS.ProcessEnv | undefined;
            const restoredStore = new PersistentSessionStore({
                databasePath,
                createRuntime: (options) => {
                    restoredEnvironment = options.secrets?.resolve(["project-service", "service"]);
                    throw new Error("Captured restored secret environment.");
                },
            });
            try {
                expect(restoredStore.listSecrets()).toEqual([
                    {
                        description: "Project service credentials",
                        environmentVariables: ["PROJECT_TOKEN"],
                        id: "project-service",
                    },
                    {
                        description: "Service API credentials",
                        environmentVariables: ["SERVICE_REGION", "SERVICE_TOKEN"],
                        id: "service",
                    },
                ]);
                const restoredSession = restoredStore.get(session.id);
                if (restoredSession === undefined) throw new Error("Expected restored session.");
                await expect(restoredSession.compact()).rejects.toThrow(
                    "Captured restored secret environment.",
                );
                expect(restoredEnvironment).toEqual({
                    PROJECT_TOKEN: "persisted-project-token",
                    SERVICE_REGION: "persisted-region",
                    SERVICE_TOKEN: "persisted-token",
                });
                expect(restoredSession.snapshot()).toMatchObject({
                    projectSecretIds: ["project-service"],
                    secretIds: ["project-service", "service"],
                    sessionSecretIds: ["service"],
                });

                const fork = restoredStore.fork(session.id);
                expect(fork?.snapshot()).toMatchObject({
                    projectSecretIds: ["project-service"],
                    secretIds: ["project-service"],
                    sessionSecretIds: [],
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("conservatively restores null, missing, and unknown agent event subtypes", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const sessionId = store.create({ cwd: "/tmp/rig-persistent-session-test" }).id;
            store.close();

            const database = new DatabaseSync(databasePath);
            insertSessionEvent(database, sessionId, "null-subtype", "agent_event", {
                event: { type: null },
                runId: "run-1",
            });
            insertSessionEvent(database, sessionId, "missing-subtype", "agent_event", {
                event: {},
                runId: "run-1",
            });
            insertSessionEvent(database, sessionId, "unknown-subtype", "agent_event", {
                event: { type: "future_provider_event" },
                runId: "run-1",
            });
            database.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(
                    restoredStore
                        .get(sessionId)
                        ?.events.since(undefined)
                        ?.map((event) => event.id),
                ).toEqual([
                    expect.any(String),
                    "null-subtype",
                    "missing-subtype",
                    "unknown-subtype",
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("restores historical masking destinations after rotating a registration", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.registerSecret({
                description: "Initial service credentials",
                environment: { OLD_SERVICE_TOKEN: "old" },
                id: "service",
            });
            const session = store.create({
                cwd: "/tmp/rotated-secret-session",
                secretIds: ["service"],
            });
            store.registerSecret({
                description: "Rotated service credentials",
                environment: { NEW_SERVICE_TOKEN: "new" },
                id: "service",
            });
            store.close();

            let restoredDestinations: readonly string[] | undefined;
            const restoredStore = new PersistentSessionStore({
                databasePath,
                createRuntime: (options) => {
                    restoredDestinations = options.secrets?.environmentVariables();
                    throw new Error("Captured restored masking destinations.");
                },
            });
            try {
                const restoredSession = restoredStore.get(session.id);
                if (restoredSession === undefined) throw new Error("Expected restored session.");
                await expect(restoredSession.compact()).rejects.toThrow(
                    "Captured restored masking destinations.",
                );
                expect(restoredDestinations).toHaveLength(2);
                expect(restoredDestinations).toEqual(
                    expect.arrayContaining(["OLD_SERVICE_TOKEN", "NEW_SERVICE_TOKEN"]),
                );
                expect(restoredStore.listSecrets()).toEqual([
                    {
                        description: "Rotated service credentials",
                        environmentVariables: ["NEW_SERVICE_TOKEN"],
                        id: "service",
                    },
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("recovers a transient event cursor across restart without replaying durable history", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-persistent-session-test" });
            const otherSession = store.create({ cwd: "/tmp/rig-other-session-test" });
            const otherSessionCursor = otherSession.snapshot().lastEventId;
            if (otherSessionCursor === undefined) throw new Error("Expected another cursor.");
            const currentCursor = session.snapshot().lastEventId;
            if (currentCursor === undefined) throw new Error("Expected a session cursor.");
            const createFutureEventId = createEventIdFactory({
                after: currentCursor,
                now: () => Date.now() + 60_000,
            });
            const transient = sessionEvent(session.id, createFutureEventId(), "agent_event", {
                event: { contentIndex: 0, delta: "live", partial: {}, type: "text_delta" },
                runId: "run-1",
            });
            session.events.append(transient);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(session.id);
                expect(restored?.snapshot().lastEventId).toBe(transient.id);
                expect(restored?.events.since(transient.id)).toEqual([]);
                expect(restored?.events.since(otherSessionCursor)).toBeUndefined();

                await restored?.changePermissionMode({ permissionMode: "read_only" });
                const catchup = restored?.events.since(transient.id);
                expect(catchup?.map((event) => event.type)).toContain("permission_mode_changed");
                expect(catchup?.every((event) => event.id > transient.id)).toBe(true);
                expect(new Set(catchup?.map((event) => event.id)).size).toBe(catchup?.length);
                expect(restored?.events.since(transient.id)).toEqual(catchup);
                expect(restored?.events.since(otherSessionCursor)).toBeUndefined();
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists registration removal and clears session and project attachments", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.registerSecret({
                description: "Disposable credentials",
                environment: { DISPOSABLE_TOKEN: "removed-value" },
                id: "disposable",
            });
            const session = store.create({
                cwd: "/tmp/removed-secret-project",
                secretIds: ["disposable"],
            });
            store.attachSecret(session.id, "disposable", "project");
            expect(store.unregisterSecret("disposable")).toBe(true);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.listSecrets()).toEqual([]);
                expect(restoredStore.get(session.id)?.snapshot()).toMatchObject({
                    projectSecretIds: [],
                    secretIds: [],
                    sessionSecretIds: [],
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps Docker execution settings across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({
                cwd: "/host/project",
                docker: {
                    environment: { PROJECT_MODE: "test" },
                    image: "local/image:tag",
                    mounts: [{ source: "/host/project", target: "/workspace" }],
                    workingDirectory: "/workspace",
                },
            });
            expect(store.fork(session.id)?.requestForSubagent().docker?.name).toBe(
                `rig-${session.id}`,
            );
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(session.id)?.requestForSubagent().docker).toEqual({
                    environment: { PROJECT_MODE: "test" },
                    image: "local/image:tag",
                    mounts: [{ source: "/host/project", target: "/workspace" }],
                    name: `rig-${session.id}`,
                    workingDirectory: "/workspace",
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("uses in-memory global events unless durable retention is explicitly enabled", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.create({ cwd: "/tmp/rig-persistent-session-test" });
            expect(store.globalEventQueue.durable).toBe(false);
            expect(store.globalEventQueue.list()).toHaveLength(3);
            store.close();

            const enabledStore = new PersistentSessionStore({
                databasePath,
                durableGlobalEventQueue: true,
            });
            expect(enabledStore.globalEventQueue?.list()).toEqual([]);
            const queuedSession = enabledStore.create({
                cwd: "/tmp/rig-persistent-session-test-enabled",
            });
            enabledStore.close();

            const disabledStore = new PersistentSessionStore({ databasePath });
            disabledStore.create({ cwd: "/tmp/rig-persistent-session-test-disabled" });
            disabledStore.close();

            const restoredStore = new PersistentSessionStore({
                databasePath,
                durableGlobalEventQueue: true,
            });
            try {
                expect(restoredStore.globalEventQueue.list()).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            event: expect.objectContaining({ sessionId: queuedSession.id }),
                        }),
                    ]),
                );
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists and trims global events independently from session history", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({
                databasePath,
                durableGlobalEventQueue: true,
            });
            const firstSession = store.create({ cwd: "/tmp/rig-persistent-session-test-a" });
            const secondSession = store.create({ cwd: "/tmp/rig-persistent-session-test-b" });
            const initial = store.globalEventQueue?.list() ?? [];
            const sessionEntries = initial.filter(
                (entry): entry is typeof entry & { event: SessionEvent } =>
                    "sessionId" in entry.event,
            );
            expect(sessionEntries.map((entry) => entry.event.sessionId)).toEqual([
                firstSession.id,
                secondSession.id,
            ]);
            const firstCursor = sessionEntries[0]?.cursor;
            const secondCursor = sessionEntries[1]?.cursor;
            const staleCursor = initial[0]?.cursor;
            expect(firstCursor).toBeDefined();
            expect(secondCursor).toBeDefined();
            expect(staleCursor).toBeDefined();
            if (
                firstCursor === undefined ||
                secondCursor === undefined ||
                staleCursor === undefined
            ) {
                throw new Error("Expected two global event cursors.");
            }
            expect(store.globalEventQueue?.trim(firstCursor)).toEqual({
                trimmed: 3,
                through: firstCursor,
            });
            expect(store.globalEventQueue?.trim(firstCursor)).toEqual({
                trimmed: 0,
                through: firstCursor,
            });
            expect(store.globalEventQueue?.list({ after: staleCursor })).toBeUndefined();
            expect(store.globalEventQueue?.list({ after: "missing.0" })).toBeUndefined();
            expect(firstSession.events.since(undefined)).toHaveLength(1);
            store.close();

            const restoredStore = new PersistentSessionStore({
                databasePath,
                durableGlobalEventQueue: true,
            });
            try {
                expect(restoredStore.globalEventQueue.list({ after: staleCursor })).toBeUndefined();
                expect(restoredStore.globalEventQueue.list()).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            cursor: secondCursor,
                            event: expect.objectContaining({ sessionId: secondSession.id }),
                        }),
                    ]),
                );
                const thirdSession = restoredStore.create({
                    cwd: "/tmp/rig-persistent-session-test-c",
                });
                const appended = restoredStore.globalEventQueue?.list({ after: secondCursor });
                expect(appended).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            event: expect.objectContaining({ sessionId: thirdSession.id }),
                        }),
                    ]),
                );
                expect(appended?.[0]?.cursor).not.toBe(secondCursor);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("rolls back a new project and session when its durable global event cannot commit", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const store = new PersistentSessionStore({
            databasePath,
            durableGlobalEventQueue: true,
        });
        const breaker = new DatabaseSync(databasePath);
        try {
            breaker.exec(`
                CREATE TRIGGER reject_project_global_event
                BEFORE INSERT ON durable_global_events
                WHEN NEW.aggregate_kind = 'project'
                BEGIN
                    SELECT RAISE(ABORT, 'rejected project event');
                END;
            `);

            expect(() => store.create({ cwd: "/tmp/rig-atomic-project-session" })).toThrow(
                "rejected project event",
            );
            expect(store.listProjects()).toEqual([]);
            expect(store.list()).toEqual([]);
            expect(store.globalEventQueue.list()).toEqual([]);
        } finally {
            breaker.close();
            store.close();
            await cleanup();
        }
    });

    it("does not publish in-memory global events from a rolled-back transaction", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const store = new PersistentSessionStore({ databasePath });
        const breaker = new DatabaseSync(databasePath);
        try {
            breaker.exec(`
                CREATE TRIGGER reject_session_insert
                BEFORE INSERT ON sessions
                BEGIN
                    SELECT RAISE(ABORT, 'rejected session insert');
                END;
            `);

            expect(() =>
                store.create({ cwd: "/tmp/rig-atomic-in-memory-project-session" }),
            ).toThrow("rejected session insert");
            expect(store.listProjects()).toEqual([]);
            expect(store.list()).toEqual([]);
            expect(store.globalEventQueue.list()).toEqual([]);
        } finally {
            breaker.close();
            store.close();
            await cleanup();
        }
    });

    it("rolls back an appended event when its session snapshot cannot be saved", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const store = new PersistentSessionStore({ databasePath });
        const session = store.create({ cwd: "/tmp/rig-atomic-event-snapshot" });
        const breaker = new DatabaseSync(databasePath);
        try {
            const before = breaker
                .prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?")
                .get(session.id) as { count: number };
            breaker.exec(`
                CREATE TRIGGER reject_session_snapshot
                BEFORE UPDATE ON sessions
                WHEN NEW.append_system_prompt = 'reject snapshot'
                BEGIN
                    SELECT RAISE(ABORT, 'rejected session snapshot');
                END;
            `);

            expect(() => session.update({ appendSystemPrompt: "reject snapshot" })).toThrow(
                "rejected session snapshot",
            );
            const after = breaker
                .prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?")
                .get(session.id) as { count: number };
            const row = breaker
                .prepare("SELECT append_system_prompt FROM sessions WHERE id = ?")
                .get(session.id) as { append_system_prompt: string | null };
            expect(after.count).toBe(before.count);
            expect(row.append_system_prompt).toBeNull();
        } finally {
            breaker.close();
            store.close();
            await cleanup();
        }
    });

    it("restores persisted session state and messages without creating a runtime", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({
                status: "completed",
            });
            const userMessage: UserMessage = {
                ...textUserMessage("message-1", "persist me"),
                agentSource: {
                    agentId: "sender-agent-id",
                    sessionId: "sender-session-id",
                    title: "Source chat",
                },
                provenance: "agent",
            };
            const toolCallMessage: AgentMessage = {
                role: "agent",
                id: "message-2",
                blocks: [
                    {
                        type: "tool_call",
                        id: "call-1",
                        name: "read",
                        arguments: { path: "src/index.ts" },
                        presentation: {
                            type: "exploration",
                            operations: [{ kind: "read", name: "index.ts" }],
                        },
                    },
                ],
            };
            store.saveSession(state);
            store.upsertMessage(state.id, {
                isPartial: false,
                message: userMessage,
                position: 0,
                runId: "run-1",
            });
            store.upsertMessage(state.id, {
                isPartial: false,
                message: toolCallMessage,
                position: 1,
                runId: "run-1",
            });
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(state.id);

                expect(restored?.snapshot().status).toBe("completed");
                expect(restored?.snapshot().snapshot.messages).toEqual([
                    userMessage,
                    toolCallMessage,
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("does not parse persisted event payloads while opening the database", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-startup-event-scan-test" });
            store.close();

            const database = new DatabaseSync(databasePath);
            database
                .prepare(
                    `
                    INSERT INTO session_events (
                        session_id, event_id, type, created_at_ms, data_json
                    ) VALUES (?, ?, ?, ?, ?)
                    `,
                )
                .run(session.id, "unreadable-event", "run_started", 1, "{");
            database.close();

            const reopened = new PersistentSessionStore({ databasePath });
            try {
                expect(reopened.list().map((entry) => entry.id)).toContain(session.id);
            } finally {
                reopened.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("reconciles a durable terminal event without appending a startup error", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const state = sessionState({
                activeRunId: "completed-before-crash",
                status: "running",
            });
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(state);
            store.close();
            const database = new DatabaseSync(databasePath);
            insertEvent(database, state.id, "durable-finish", "run_finished", 10, {
                agentRunId: "agent-run",
                modelLocked: false,
                runId: "completed-before-crash",
                stopReason: "stop",
            });
            database.close();

            const reopened = new PersistentSessionStore({ databasePath });
            reopened.close();

            const verify = new DatabaseSync(databasePath);
            try {
                expect(
                    verify
                        .prepare("SELECT status, active_run_id FROM sessions WHERE id = ?")
                        .get(state.id),
                ).toEqual({ active_run_id: null, status: "completed" });
                expect(
                    verify
                        .prepare(
                            "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'run_error'",
                        )
                        .get(state.id),
                ).toEqual({ count: 0 });
            } finally {
                verify.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("does not promote active steering after restart interruption, including on reopen", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const active = textUserMessage("active-orphan", "still active at restart");
            const state = sessionState({
                activeRunId: "active-run",
                modelId: "openai/test",
                models: testModelCatalog().models,
                providerId: "codex",
                status: "running",
            });
            const store = new PersistentSessionStore({
                databasePath,
                modelCatalog: testModelCatalog(),
            });
            store.saveSession(state);
            store.close();
            const database = new DatabaseSync(databasePath);
            insertEvent(database, state.id, "active-start", "run_started", 1, {
                runId: "active-run",
            });
            insertEvent(database, state.id, "active-submit", "message_submitted", 2, {
                delivery: "steer",
                displayText: "still active at restart",
                message: active,
                runId: "active-run",
            });
            database.close();

            for (let open = 0; open < 2; open += 1) {
                const restored = new PersistentSessionStore({
                    databasePath,
                    modelCatalog: testModelCatalog(),
                    now: () => 100 + open,
                });
                restored.close();
                const verify = new DatabaseSync(databasePath);
                try {
                    expect(
                        verify
                            .prepare(
                                "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                            )
                            .get(state.id, active.id),
                    ).toEqual({ count: 0 });
                    expect(
                        verify
                            .prepare(
                                "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'steering_applied'",
                            )
                            .get(state.id),
                    ).toEqual({ count: 0 });
                    const restartErrors = verify
                        .prepare(
                            "SELECT data_json FROM session_events WHERE session_id = ? AND type = 'run_error'",
                        )
                        .all(state.id) as { data_json: string }[];
                    expect(restartErrors.map((row) => JSON.parse(row.data_json))).toEqual([
                        expect.objectContaining({
                            runId: "active-run",
                            startupInterruption: true,
                        }),
                    ]);
                } finally {
                    verify.close();
                }
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps restart-interrupted steering excluded after a later run clears interruption state", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const active = textUserMessage("restart-orphan", "never reached inference");
            const later = textUserMessage("later-run-message", "completed after restart");
            const state = sessionState({
                activeRunId: "crashed-run",
                modelId: "openai/test",
                models: testModelCatalog().models,
                providerId: "codex",
                status: "running",
            });
            const store = new PersistentSessionStore({
                databasePath,
                modelCatalog: testModelCatalog(),
            });
            store.saveSession(state);
            store.close();
            const database = new DatabaseSync(databasePath);
            insertEvent(database, state.id, "crashed-start", "run_started", 1, {
                runId: "crashed-run",
            });
            insertEvent(database, state.id, "crashed-steer", "message_submitted", 2, {
                delivery: "steer",
                displayText: "never reached inference",
                message: active,
                runId: "crashed-run",
            });
            database.close();

            const firstReopen = new PersistentSessionStore({
                databasePath,
                modelCatalog: testModelCatalog(),
                now: () => 100,
            });
            firstReopen.close();

            const laterDatabase = new DatabaseSync(databasePath);
            insertEvent(laterDatabase, state.id, "later-start", "run_started", 4, {
                runId: "later-run",
            });
            insertEvent(laterDatabase, state.id, "later-submit", "message_submitted", 5, {
                delivery: "run",
                displayText: "completed after restart",
                message: later,
                runId: "later-run",
            });
            insertEvent(laterDatabase, state.id, "later-finished", "run_finished", 6, {
                agentRunId: "later-agent-run",
                modelLocked: true,
                runId: "later-run",
                stopReason: "stop",
            });
            laterDatabase
                .prepare(
                    "UPDATE sessions SET status = 'completed', active_run_id = NULL, interrupted = 0, interruption_json = NULL WHERE id = ?",
                )
                .run(state.id);
            laterDatabase.close();

            const secondReopen = new PersistentSessionStore({
                databasePath,
                modelCatalog: testModelCatalog(),
                now: () => 200,
            });
            secondReopen.close();

            const verify = new DatabaseSync(databasePath);
            try {
                expect(
                    verify
                        .prepare(
                            "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                        )
                        .get(state.id, active.id),
                ).toEqual({ count: 0 });
                expect(
                    verify
                        .prepare(
                            "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'steering_applied'",
                        )
                        .get(state.id),
                ).toEqual({ count: 0 });
                const crashError = verify
                    .prepare(
                        "SELECT data_json FROM session_events WHERE session_id = ? AND type = 'run_error'",
                    )
                    .get(state.id) as { data_json: string };
                expect(JSON.parse(crashError.data_json)).toEqual(
                    expect.objectContaining({
                        runId: "crashed-run",
                        startupInterruption: true,
                    }),
                );
            } finally {
                verify.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("does not promote suspended subagent steering on the second restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const active = textUserMessage("suspended-orphan", "not applied before suspension");
            const store = new PersistentSessionStore({
                databasePath,
                modelCatalog: testModelCatalog(),
            });
            store.saveSession(sessionState());
            const state = sessionState({
                activeRunId: "suspended-run",
                agent: {
                    depth: 1,
                    description: "Wait for more work",
                    parentSessionId: "session-1",
                    rootSessionId: "session-1",
                    type: "subagent",
                },
                agentId: "subagent-agent",
                id: "subagent-1",
                status: "suspended",
            });
            store.saveSession(state);
            store.close();
            const database = new DatabaseSync(databasePath);
            insertEvent(database, state.id, "suspended-start", "run_started", 1, {
                runId: "suspended-run",
            });
            insertEvent(database, state.id, "suspended-submit", "message_submitted", 2, {
                delivery: "steer",
                displayText: "not applied before suspension",
                message: active,
                runId: "suspended-run",
            });
            database.close();

            let restartNotification: string | undefined;
            for (let open = 0; open < 2; open += 1) {
                const restored = new PersistentSessionStore({
                    databasePath,
                    modelCatalog: testModelCatalog(),
                });
                restartNotification ??= restored
                    .get("session-1")
                    ?.snapshot()
                    .snapshot.messages.flatMap((message) =>
                        message.blocks.flatMap((block) =>
                            block.type === "text" ? [block.text] : [],
                        ),
                    )
                    .find((text) => text.includes("<subagent-notification>"));
                restored.close();
            }
            expect(restartNotification).toContain("Agent ID: subagent-agent");
            expect(restartNotification).toContain("Path: /root/subagent-agent");
            expect(restartNotification).not.toContain("Task:");
            expect(restartNotification).not.toContain("subagent-1");

            const verify = new DatabaseSync(databasePath);
            try {
                expect(
                    verify
                        .prepare(
                            "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                        )
                        .get(state.id, active.id),
                ).toEqual({ count: 0 });
                expect(
                    verify
                        .prepare(
                            "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'steering_applied'",
                        )
                        .get(state.id),
                ).toEqual({ count: 0 });
                const restartError = verify
                    .prepare(
                        "SELECT data_json FROM session_events WHERE session_id = ? AND type = 'run_error'",
                    )
                    .get(state.id) as { data_json: string };
                expect(JSON.parse(restartError.data_json)).toEqual(
                    expect.objectContaining({
                        runId: "suspended-run",
                        startupInterruption: true,
                    }),
                );
            } finally {
                verify.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps workflows disabled across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const sessionId = store.create({
                cwd: "/tmp/rig-persistent-session-test",
                workflowsEnabled: false,
            }).id;
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(sessionId);
                expect(restored?.snapshot().workflowsEnabled).toBe(false);
                expect(() =>
                    restored?.launchWorkflow({
                        code: "42",
                        description: "Must stay disabled",
                        execute: async () => ({ agentCalls: [], output: 42 }),
                        name: "disabled-workflow",
                    }),
                ).toThrow("Workflows are disabled for this session.");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a Monty checkpoint and completed workflow calls across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({
                workflows: [
                    {
                        agentCalls: [{ output: "cached", signature: "cached-signature" }],
                        checkpoint: {
                            nextAgentCallIndex: 1,
                            phase: "Verify",
                            snapshotBase64: Buffer.from([1, 2, 3]).toString("base64"),
                        },
                        state: {
                            agentCount: 1,
                            code: 'agent("check")',
                            description: "Persist checkpoint",
                            logs: [],
                            name: "persist-checkpoint",
                            runId: "workflow-before-restart",
                            startedAt: 1,
                            status: "running",
                            taskId: "workflow:workflow-before-restart",
                        },
                    },
                ],
            });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(state.id);
                expect(restored?.getWorkflow("workflow-before-restart")).toMatchObject({
                    error: "The workflow was interrupted when the local server stopped.",
                    status: "stopped",
                });
                let receivedCheckpoint: unknown;
                let receivedAgentCalls: readonly unknown[] = [];
                restored?.launchWorkflow({
                    code: 'agent("check")',
                    description: "Resume checkpoint",
                    execute: async (options) => {
                        receivedCheckpoint = options.resumeCheckpoint;
                        receivedAgentCalls = options.resumeAgentCalls;
                        return { agentCalls: options.resumeAgentCalls, output: "resumed" };
                    },
                    name: "persist-checkpoint",
                    resumeFromRunId: "workflow-before-restart",
                });
                await new Promise((resolve) => setImmediate(resolve));

                expect(receivedCheckpoint).toMatchObject({
                    nextAgentCallIndex: 1,
                    phase: "Verify",
                    snapshot: new Uint8Array([1, 2, 3]),
                });
                expect(receivedAgentCalls).toEqual([
                    { output: "cached", signature: "cached-signature" },
                ]);
                const notificationRun = restored?.events
                    .since(undefined)
                    ?.findLast((event) => event.type === "run_started");
                if (notificationRun?.type !== "run_started") {
                    throw new Error("Expected the completed workflow notification to start a run.");
                }
                await restored?.abort();
                await restored?.waitForRun(notificationRun.data.runId);
                await new Promise((resolve) => setImmediate(resolve));
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a rewound transcript across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const messages = [
                textUserMessage("message-1", "Keep this"),
                textUserMessage("message-2", "Rewind this"),
                textUserMessage("message-3", "Remove this too"),
            ];
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ contextMessages: messages, status: "completed" });
            store.saveSession(state);
            messages.forEach((message, position) => {
                store.upsertMessage(state.id, {
                    isPartial: false,
                    message,
                    position,
                    runId: `run-${position + 1}`,
                });
            });
            store.close();

            const rewindStore = new PersistentSessionStore({ databasePath });
            rewindStore.get(state.id)?.rewind("message-2");
            rewindStore.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(state.id)?.snapshot().snapshot;
                expect(restored?.messages).toEqual([messages[0]]);
                expect(restored?.contextMessages).toBeUndefined();
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("resumes from compacted model context instead of the visible transcript", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const summaryMessage: CompactionMessage = {
            blocks: [],
            id: "summary-1",
            providerId: "claude",
            replacementMessages: [{ role: "user", content: "Earlier work.", timestamp: 1 }],
            replacedMessageIds: ["visible-1"],
            role: "compaction",
            statistics: {
                after: { exact: false, tokens: 20 },
                before: { exact: true, tokens: 100 },
            },
        };
        const visibleMessage = textUserMessage("visible-1", "The original full transcript.");
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ contextMessages: [summaryMessage] });
            store.saveSession(state);
            store.upsertMessage(state.id, {
                isPartial: false,
                message: visibleMessage,
                position: 0,
                runId: "run-1",
            });
            store.upsertMessage(state.id, {
                isPartial: false,
                message: summaryMessage,
                position: 1,
                runId: "run-1",
            });
            store.close();

            let restoredRuntimeOptions:
                | { contextMessages?: readonly unknown[]; messages?: readonly unknown[] }
                | undefined;
            const restoredStore = new PersistentSessionStore({
                createRuntime: (options) => {
                    restoredRuntimeOptions = options;
                    throw new Error("Captured resumed runtime options.");
                },
                databasePath,
            });
            try {
                const restored = restoredStore.get(state.id);

                expect(restored?.snapshot().snapshot.messages).toEqual([
                    visibleMessage,
                    summaryMessage,
                ]);
                expect(restored?.snapshot().snapshot.contextMessages).toEqual([summaryMessage]);
                expect(() => restored?.externalControlContext()).toThrow(
                    "Captured resumed runtime options.",
                );
                expect(restoredRuntimeOptions).toMatchObject({
                    contextMessages: [summaryMessage],
                    messages: [summaryMessage],
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("stores the complete active inference context in its own ordered table", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const first = textUserMessage("context-1", "First inference message.");
        const second = textUserMessage("context-2", "Second inference message.");
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ contextMessages: [first, second] });
            store.saveSession(state);
            store.saveSession({ ...state, contextMessages: [second] });
            store.close();

            const database = new DatabaseSync(databasePath);
            try {
                expect(
                    database
                        .prepare("PRAGMA table_info(sessions)")
                        .all()
                        .map((column) => String(column.name)),
                ).not.toContain("context_messages_json");
                expect(
                    database
                        .prepare(
                            `
                            SELECT position, message_id, role, message_json
                            FROM session_context_messages
                            WHERE session_id = ?
                            ORDER BY position
                            `,
                        )
                        .all(state.id),
                ).toEqual([
                    {
                        message_id: second.id,
                        message_json: JSON.stringify(second),
                        position: 0,
                        role: "user",
                    },
                ]);
            } finally {
                database.close();
            }

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(state.id)?.state().contextMessages).toEqual([second]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists internal context messages without exposing them in the session snapshot", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const internalContinuation: UserMessage = {
            blocks: [{ text: "Continue after the inference crash.", type: "text" }],
            id: "internal-crash-continuation",
            internal: true,
            role: "user",
        };
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ contextMessages: [internalContinuation] });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(state.id);

                expect(restored?.state().contextMessages).toEqual([internalContinuation]);
                expect(restored?.snapshot().snapshot.messages).toEqual([]);
                expect(restored?.snapshot().snapshot.contextMessages).toEqual([]);
                expect(JSON.stringify(restored?.events.since(undefined))).not.toContain(
                    "Continue after the inference crash.",
                );
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a partial provider failure without replaying it", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/sonnet-5",
            name: "Claude Test",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "claude",
            models: [model],
            providers: [{ models: [model], providerId: "claude" }],
        };
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        const originalOverrides = process.env.RIG_GYM_PROVIDER_OVERRIDES;
        const requests: GymInferenceRequest[] = [];
        let store: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            process.env.RIG_GYM_PROVIDER_OVERRIDES = "claude";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                if (requests.length === 1) {
                    return new Response(
                        JSON.stringify({
                            content: [{ text: "DURABLE_PARTIAL_UNSENT", type: "text" }],
                            errorAfterTextDeltas: 1,
                            errorMessage: "WebSocket error",
                            stopReason: "error",
                            textDeltaChunkSize: 15,
                        }),
                        { headers: { "content-type": "application/json" }, status: 200 },
                    );
                }
                return new Response(
                    JSON.stringify({ content: [{ text: "Recovered session", type: "text" }] }),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const session = store.create({
                cwd: "/tmp/rig-internal-crash-continuation",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: "claude",
            });
            const submitted = session.submit({ text: "Recover this response." });
            await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
                errorMessage: "WebSocket error",
                status: "error",
            });

            expect(requests).toHaveLength(1);
            expect(
                session.state().contextMessages?.findLast((message) => message.role === "agent"),
            ).toMatchObject({
                role: "agent",
                blocks: [{ type: "text", text: "DURABLE_PARTIAL" }],
            });
            expect(session.state().contextMessages?.at(-1)).toMatchObject({
                blocks: [{ type: "text", text: "WebSocket error" }],
                outcome: "failed",
                role: "error",
            });
            expect(JSON.stringify(session.snapshot().snapshot)).not.toContain(
                "Continue after the inference crash.",
            );

            store.close();
            store = undefined;

            const restoredStore = new PersistentSessionStore({
                databasePath,
                modelCatalog: catalog,
            });
            try {
                const restored = restoredStore.get(session.id);
                expect(restored).toBeDefined();
                await expect(restored?.waitForRun(submitted.runId)).resolves.toEqual({
                    errorMessage: "WebSocket error",
                    status: "error",
                });
                expect(restored?.state().contextMessages?.at(-1)).toMatchObject({
                    blocks: [{ type: "text", text: "WebSocket error" }],
                    outcome: "failed",
                    role: "error",
                });
                expect(
                    restored
                        ?.state()
                        .contextMessages?.findLast((message) => message.role === "agent"),
                ).toMatchObject({
                    blocks: [{ type: "text", text: "DURABLE_PARTIAL" }],
                    role: "agent",
                });
                expect(restored?.state().contextMessages).not.toContainEqual(
                    expect.objectContaining({ internal: true }),
                );
                expect(JSON.stringify(restored?.snapshot().snapshot)).not.toContain(
                    "Continue after the inference crash.",
                );
            } finally {
                restoredStore.close();
            }
        } finally {
            store?.close();
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            if (originalOverrides === undefined) delete process.env.RIG_GYM_PROVIDER_OVERRIDES;
            else process.env.RIG_GYM_PROVIDER_OVERRIDES = originalOverrides;
            await cleanup();
        }
    });

    it("persists the permission mode in session details and summaries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ permissionMode: "read_only" });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(state.id)?.snapshot().permissionMode).toBe("read_only");
                expect(restoredStore.list().at(0)?.permissionMode).toBe("read_only");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("reports the stored context size in session summaries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({
                sessionTokenCount: { lastContextTokens: 34_500, totalTokens: 120_000 },
            });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.list().at(0)?.sessionTokenCount).toEqual({
                    lastContextTokens: 34_500,
                    totalTokens: 120_000,
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists the selected service tier in session details and summaries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ serviceTier: "fast" });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(state.id)?.snapshot()).toMatchObject({
                    serviceTier: "fast",
                    snapshot: { serviceTier: "fast" },
                });
                expect(restoredStore.list().at(0)?.serviceTier).toBe("fast");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("restores fast inference into the runtime and persists disabling it", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ providerId: "gym", models: [model], serviceTiers: ["fast"] }],
        };
        const inferenceRequests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let openStore: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") {
                    throw new Error("Expected a serialized gym inference request.");
                }
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                inferenceRequests.push(request);
                return new Response(
                    JSON.stringify({
                        content: [{ text: "Done.", type: "text" }],
                        stopReason: "stop",
                    }),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            openStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const created = openStore.create({
                cwd: "/tmp/rig-fast-persistence-test",
                modelId: model.id,
                providerId: "gym",
                serviceTier: "fast",
            });
            openStore.saveSession({
                ...created.state(),
                title: "Fast persistence",
                titleStatus: "ready",
            });
            const sessionId = created.id;
            openStore.close();
            openStore = undefined;

            openStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const fastSession = openStore.get(sessionId);
            expect(fastSession?.snapshot()).toMatchObject({
                serviceTier: "fast",
                snapshot: { serviceTier: "fast" },
            });
            const fastRun = fastSession?.submit({ text: "Use fast inference." });
            expect(fastRun).toBeDefined();
            if (fastRun === undefined || fastSession === undefined) {
                throw new Error("Expected the restored fast session.");
            }
            await expect(fastSession.waitForRun(fastRun.runId)).resolves.toEqual({
                status: "completed",
            });
            await new Promise((resolve) => setImmediate(resolve));
            expect(inferenceRequests).toHaveLength(1);
            expect(inferenceRequests[0]?.options.serviceTier).toBe("fast");

            fastSession.changeServiceTier({});
            expect(fastSession.snapshot().serviceTier).toBeUndefined();
            openStore.close();
            openStore = undefined;

            const disabledDatabase = new DatabaseSync(databasePath);
            try {
                expect(
                    disabledDatabase
                        .prepare("SELECT service_tier FROM sessions WHERE id = ?")
                        .get(sessionId),
                ).toEqual({ service_tier: null });
            } finally {
                disabledDatabase.close();
            }

            openStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const normalSession = openStore.get(sessionId);
            expect(normalSession?.snapshot().serviceTier).toBeUndefined();
            const normalRun = normalSession?.submit({ text: "Use normal inference." });
            expect(normalRun).toBeDefined();
            if (normalRun === undefined || normalSession === undefined) {
                throw new Error("Expected the restored normal session.");
            }
            await expect(normalSession.waitForRun(normalRun.runId)).resolves.toEqual({
                status: "completed",
            });
            await new Promise((resolve) => setImmediate(resolve));
            expect(inferenceRequests).toHaveLength(2);
            expect(inferenceRequests[1]?.options.serviceTier).toBeUndefined();
        } finally {
            openStore?.close();
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) {
                delete process.env.RIG_GYM_INFERENCE_URL;
            } else {
                process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            }
            await cleanup();
        }
    });

    it("persists goal state across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({
                goal: {
                    createdAt: 1_700_000_000_000,
                    objective: "Finish the release",
                    status: "paused",
                    updatedAt: 1_700_000_001_000,
                },
            });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(state.id)?.snapshot().goal).toEqual(state.goal);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists lifecycle and unread session behavior across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({
                archived: true,
                trackUnread: true,
                unread: { reason: "turn_finished", since: 1_700_000_000_000 },
            });
            store.saveSession(state);
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get(state.id)?.snapshot()).toMatchObject({
                    archived: true,
                    trackUnread: true,
                    unread: state.unread,
                });
                expect(restoredStore.list()).toMatchObject([
                    {
                        archived: true,
                        id: state.id,
                        trackUnread: true,
                        unread: state.unread,
                    },
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists completed structured question events without reviving the prompt", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-persistent-session-test" });
            const pending = session.requestUserInput({
                requestId: "question-1",
                questions: [
                    {
                        header: "Database",
                        id: "database",
                        multiSelect: false,
                        options: [
                            { label: "PostgreSQL", description: "Use a server database." },
                            { label: "SQLite", description: "Use a local database." },
                        ],
                        question: "Which database should be used?",
                    },
                ],
            });
            session.answerUserInput("question-1", { answers: { database: ["SQLite"] } });
            await pending;
            const sessionId = session.id;
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(sessionId);
                expect(restored?.snapshot().pendingUserInputs).toEqual([]);
                expect(restored?.events.since(undefined)?.map((event) => event.type)).toEqual([
                    "session_created",
                    "user_input_requested",
                    "user_input_resolved",
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists task state and does not reuse deleted task identifiers", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const session = store.create({ cwd: "/tmp/rig-persistent-session-test" });
            session.createTask({ subject: "First", description: "Do the first task." });
            session.createTask({ subject: "Second", description: "Do the second task." });
            session.updateTask("2", { status: "deleted" });
            const sessionId = session.id;
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(sessionId);
                expect(restored?.listTasks()).toEqual([
                    expect.objectContaining({ id: "1", subject: "First" }),
                ]);
                expect(
                    restored?.createTask({
                        subject: "Third",
                        description: "Do the third task.",
                    }).id,
                ).toBe("3");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a fallback when a restored model is no longer available", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const availableModel = defineModel({
            id: "openai/available",
            name: "Available model",
            thinkingLevels: ["off", "medium"],
            defaultThinkingLevel: "medium",
        });
        const removedModel = defineModel({
            id: "removed/model",
            name: "Removed model",
            thinkingLevels: ["off", "high", "max"],
            defaultThinkingLevel: "max",
        });
        const availableCatalog: ModelCatalog = {
            defaultModelId: availableModel.id,
            defaultProviderId: "codex",
            models: [availableModel],
            providers: [{ providerId: "codex", models: [availableModel] }],
        };
        try {
            const store = new PersistentSessionStore({
                databasePath,
                modelCatalog: {
                    defaultModelId: availableModel.id,
                    defaultProviderId: "codex",
                    models: [availableModel, removedModel],
                    providers: [
                        { providerId: "codex", models: [availableModel] },
                        { providerId: "bedrock", models: [removedModel] },
                    ],
                },
            });
            const sessionId = store.create({
                cwd: "/tmp/rig-persistent-session-test",
                effort: "max",
                modelId: removedModel.id,
                providerId: "bedrock",
            }).id;
            store.close();

            const restoredStore = new PersistentSessionStore({
                databasePath,
                modelCatalog: availableCatalog,
            });
            try {
                expect(restoredStore.get(sessionId)?.snapshot()).toMatchObject({
                    effort: "medium",
                    modelId: availableModel.id,
                    providerId: "codex",
                });
                expect(
                    restoredStore.list().find((session) => session.id === sessionId),
                ).toMatchObject({
                    effort: "medium",
                    modelId: availableModel.id,
                    providerId: "codex",
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("marks running sessions as interrupted after a restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({
                databasePath,
                now: () => 1_700_000_000_000,
            });
            const queuedRun: PersistedQueuedRun = {
                displayText: "queued prompt",
                kind: "user",
                runId: "run-2",
                text: "queued prompt",
                userMessage: textUserMessage("message-2", "queued prompt"),
            };
            store.saveSession(
                sessionState({
                    activeRunId: "run-1",
                    queuedRuns: [queuedRun],
                    status: "running",
                }),
            );
            store.insertQueuedRun("session-1", queuedRun);
            store.close();

            const restoredStore = new PersistentSessionStore({
                databasePath,
                now: () => 1_700_000_000_100,
            });
            try {
                const restored = restoredStore.get("session-1");
                const events = restored?.events.since(undefined) ?? [];

                expect(restored?.snapshot().status).toBe("error");
                expect(restored?.snapshot().interruption).toMatchObject({
                    reason: "crash",
                    runId: "run-1",
                });
                expect(events.filter((event) => event.type === "run_error")).toHaveLength(2);
                // The interrupted run moves the session to the error status, and
                // that transition is announced so an attached client learns the
                // crash without re-reading the session.
                expect(events.map((event) => event.type)).toEqual([
                    "run_error",
                    "session_status_changed",
                    "run_error",
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("publishes a repaired child status to its parent after a restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(sessionState());
            store.saveSession(
                sessionState({
                    activeRunId: "child-run-1",
                    agent: {
                        depth: 1,
                        description: "Inspect the crash path",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    status: "running",
                }),
            );
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const parentEvents = restoredStore.get("session-1")?.events.since(undefined) ?? [];
                const changed = parentEvents.find((event) => event.type === "subagent_changed");

                expect(changed).toMatchObject({
                    data: {
                        subagent: {
                            id: "subagent-1",
                            status: "error",
                        },
                    },
                    type: "subagent_changed",
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("restores a parent metadata boundary with a persisted child without recursion", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(sessionState());
            store.saveSession(
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect the resume boundary",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    status: "completed",
                }),
            );
            store.get("session-1")?.markInterrupted({
                interruptedAt: 1_700_000_000_000,
                message: "The parent was interrupted before restart.",
                reason: "shutdown",
                runId: "parent-run-1",
            });
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.get("session-1")?.snapshot()).toMatchObject({
                    id: "session-1",
                    interruption: { runId: "parent-run-1" },
                });
                expect(restoredStore.get("subagent-1")?.agentMetadata()).toMatchObject({
                    parentSessionId: "session-1",
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("reuses a stopped subagent session for model-directed follow-up after restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const requests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let restoredStore: PersistentSessionStore | undefined;
        try {
            const oldTask = textUserMessage("old-task", "Remember the original delegated context.");
            const oldResponse = {
                blocks: [{ text: "Original work stopped.", type: "text" }],
                id: "old-response",
                role: "agent",
            } as const;
            const store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            store.saveSession(
                sessionState({
                    modelId: model.id,
                    models: [model],
                    providerId: "gym",
                    title: "Parent",
                    titleStatus: "ready",
                }),
            );
            store.saveSession(
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect persisted work",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        taskName: "persisted_worker",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    contextMessages: [oldTask, oldResponse],
                    modelId: model.id,
                    models: [model],
                    providerId: "gym",
                    status: "aborted",
                    title: "Persisted worker",
                    titleStatus: "ready",
                }),
            );
            store.upsertMessage("subagent-1", {
                isPartial: false,
                message: oldTask,
                position: 0,
                runId: "old-run",
            });
            store.upsertMessage("subagent-1", {
                isPartial: false,
                message: oldResponse,
                position: 1,
                runId: "old-run",
            });
            store.close();

            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                const userTexts = request.context.messages.flatMap((message) =>
                    message.role === "user" ? [providerMessageText(message.content)] : [],
                );
                const lastMessage = request.context.messages.at(-1);
                const lastUserText = userTexts.at(-1) ?? "";
                const response = lastUserText.includes("<subagent-notification>")
                    ? { content: [{ text: "PERSISTED_CHILD_REPORTED", type: "text" }] }
                    : userTexts.includes("Continue the persisted investigation.")
                      ? { content: [{ text: "PERSISTED_CHILD_REUSED", type: "text" }] }
                      : lastMessage?.role === "toolResult" &&
                          lastMessage.toolName === "followup_task"
                        ? { content: [{ text: "FOLLOWUP_ACCEPTED", type: "text" }] }
                        : {
                              content: [
                                  {
                                      arguments: {
                                          message: "Continue the persisted investigation.",
                                          target: "/root/persisted_worker",
                                      },
                                      id: "follow-up-persisted-worker",
                                      name: "followup_task",
                                      namespace: "collaboration",
                                      type: "toolCall",
                                  },
                              ],
                          };
                return new Response(JSON.stringify(response), {
                    headers: { "content-type": "application/json" },
                    status: 200,
                });
            };

            const taskDrain = new TrackedTaskDrain();
            restoredStore = new PersistentSessionStore({
                databasePath,
                modelCatalog: catalog,
                taskDrain,
            });
            const parent = restoredStore.get("session-1");
            if (parent === undefined) throw new Error("Expected the restored parent session.");
            const submitted = parent.submit({ text: "Ask the old worker to continue." });
            await expect(parent.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });

            const child = restoredStore.get("subagent-1");
            if (child === undefined) throw new Error("Expected the restored child session.");
            const followUpEvent = child.events
                .since(undefined)
                ?.find(
                    (event): event is Extract<SessionEvent, { type: "message_submitted" }> =>
                        event.type === "message_submitted" &&
                        event.data.displayText === "Continue the persisted investigation.",
                );
            const followUpRunId = followUpEvent?.data.runId;
            if (followUpRunId === undefined) throw new Error("Expected the child follow-up run.");
            await expect(child.waitForRun(followUpRunId)).resolves.toEqual({
                status: "completed",
            });
            expect(
                requests.some((request) => {
                    const texts = request.context.messages.flatMap((message) =>
                        message.role === "user" ? [providerMessageText(message.content)] : [],
                    );
                    return (
                        texts.includes("Remember the original delegated context.") &&
                        texts.includes("Continue the persisted investigation.")
                    );
                }),
            ).toBe(true);
            await restoredStore.prepareForShutdown("shutdown");
            restoredStore.close();
            restoredStore = undefined;
        } finally {
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            restoredStore?.close();
            await cleanup();
        }
    });

    it("updates partial messages in place while streaming", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ status: "running" });
            store.saveSession(state);
            store.upsertMessage(state.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "hel", type: "text" }],
                    id: "assistant-1",
                    role: "agent",
                },
                position: 0,
                runId: "run-1",
            });
            store.upsertMessage(state.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "hello", type: "text" }],
                    id: "assistant-1",
                    role: "agent",
                },
                position: 0,
                runId: "run-1",
            });
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(state.id);

                expect(restored?.state().messages).toEqual([
                    {
                        isPartial: true,
                        message: {
                            blocks: [{ text: "hello", type: "text" }],
                            id: "assistant-1",
                            role: "agent",
                        },
                        position: 0,
                        runId: "run-1",
                    },
                ]);
                expect(restored?.snapshot().snapshot.messages).toEqual([]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps older transcript paging reachable when a partial message is restored", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const state = sessionState({ status: "running" });
            store.saveSession(state);
            for (let position = 0; position < 81; position += 1) {
                store.upsertMessage(state.id, {
                    isPartial: false,
                    message: textUserMessage(`message-${String(position)}`, String(position)),
                    position,
                    runId: `run-${String(position)}`,
                });
            }
            store.upsertMessage(state.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "Still writing", type: "text" }],
                    id: "partial-1",
                    role: "agent",
                },
                position: 81,
                runId: "run-80",
            });
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(state.id);
                expect(restored?.transcriptWindow().complete).toBe(false);
                expect(
                    new Set(restored?.state().messages.map((entry) => entry.position)).size,
                ).toBe(restored?.state().messages.length);
                expect(restored?.transcriptPage(10, "run-1")?.turns[0]?.runId).toBe("run-0");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("pages forward from a persisted message event without skipping turns", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            try {
                const session = store.create({ cwd: "/tmp/rig-persisted-forward" });
                for (const text of ["One.", "Two.", "Three."]) {
                    session.submitContext({ text });
                }
                const anchors = (session.events.since(undefined) ?? [])
                    .filter((event) => event.type === "message_submitted")
                    .map((event) => event.id);

                const first = store.loadTranscriptSince(session.id, 2, anchors[0]!);
                expect(JSON.stringify(first?.messages)).toContain("One.");
                expect(JSON.stringify(first?.messages)).toContain("Two.");
                expect(JSON.stringify(first?.messages)).not.toContain("Three.");
                expect(first?.complete).toBe(false);

                const second = store.loadTranscriptSince(session.id, 2, anchors[1]!);
                expect(JSON.stringify(second?.messages)).toContain("Two.");
                expect(JSON.stringify(second?.messages)).toContain("Three.");
                expect(second?.complete).toBe(true);
            } finally {
                store.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("stores the model, provider, and fast mode a queued run carries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const queuedRun: PersistedQueuedRun = {
                displayText: "queued prompt",
                effort: "high",
                kind: "user",
                modelId: "openai/queued",
                providerId: "codex",
                runId: "run-1",
                serviceTier: "fast",
                text: "queued prompt",
                userMessage: textUserMessage("message-1", "queued prompt"),
            };
            store.saveSession(sessionState({ queuedRuns: [queuedRun], status: "queued" }));
            store.insertQueuedRun("session-1", queuedRun);

            // Reading the session back parses the stored row. Dropping any of these would run the
            // message on a different model than the one it asked for, wherever a stored queue is
            // resumed rather than discarded.
            expect(store.get("session-1")?.state().queuedRuns[0]).toMatchObject({
                effort: "high",
                modelId: "openai/queued",
                providerId: "codex",
                serviceTier: "fast",
            });
            store.close();
        } finally {
            await cleanup();
        }
    });

    it("emits terminal events for accepted queued runs that are aborted before start", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const queuedRun: PersistedQueuedRun = {
                displayText: "queued prompt",
                kind: "user",
                runId: "run-1",
                text: "queued prompt",
                userMessage: textUserMessage("message-1", "queued prompt"),
            };
            store.saveSession(
                sessionState({
                    queuedRuns: [queuedRun],
                    status: "queued",
                }),
            );
            store.insertQueuedRun("session-1", queuedRun);

            const session = store.get("session-1");
            const response = await session?.abort();
            const events = session?.events.since(undefined) ?? [];

            expect(response?.aborted).toBe(true);
            expect(events.map((event) => event.type)).toEqual(["abort_requested", "run_error"]);
            expect(events.at(-1)).toMatchObject({
                data: { runId: "run-1" },
                type: "run_error",
            });
            store.close();
        } finally {
            await cleanup();
        }
    });

    it("lists sessions by most recent submitted message", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(
                sessionState({
                    id: "older-session",
                    lastMessageAt: 1_700_000_000_000,
                    title: "Older Work",
                    titleStatus: "ready",
                }),
            );
            store.saveSession(
                sessionState({
                    id: "newer-session",
                    lastMessageAt: 1_700_000_001_000,
                    title: "Newer Work",
                    titleStatus: "ready",
                }),
            );

            const sessions = store.list({ limit: 1 });

            expect(sessions).toEqual([
                expect.objectContaining({
                    id: "newer-session",
                    title: "Newer Work",
                }),
            ]);
            store.close();
        } finally {
            await cleanup();
        }
    });

    it("persists settled session metadata", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(
                sessionState({
                    title: "Persisted Title",
                    titleStatus: "ready",
                    recap: "The persisted recap remains available after restart.",
                    metadataRunId: "run-1",
                    metadataUpdatedAt: 1_700_000_002_000,
                }),
            );
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get("session-1");
                const summary = restoredStore.list({ limit: 1 }).at(0);

                expect(restored?.snapshot()).toMatchObject({
                    title: "Persisted Title",
                    titleStatus: "ready",
                    recap: "The persisted recap remains available after restart.",
                    metadataRunId: "run-1",
                    metadataUpdatedAt: 1_700_000_002_000,
                });
                expect(summary).toMatchObject({
                    title: "Persisted Title",
                    titleStatus: "ready",
                    recap: "The persisted recap remains available after restart.",
                    metadataRunId: "run-1",
                    metadataUpdatedAt: 1_700_000_002_000,
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("changes models after restoring an existing conversation", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const catalog = testModelCatalog();
        try {
            const store = new PersistentSessionStore({ databasePath, modelCatalog: catalog });
            const userMessage = textUserMessage("message-1", "started");
            const state = sessionState({
                effort: "low",
                messages: [
                    {
                        isPartial: false,
                        message: userMessage,
                        position: 0,
                        runId: "run-1",
                    },
                ],
                modelId: "openai/test",
                models: catalog.models,
            });
            store.saveSession(state);
            const entry = state.messages[0];
            expect(entry).toBeDefined();
            if (entry !== undefined) {
                store.upsertMessage(state.id, entry);
            }
            store.close();

            const restoredStore = new PersistentSessionStore({
                databasePath,
                modelCatalog: catalog,
            });
            try {
                const restored = restoredStore.get(state.id);

                expect(restored?.snapshot().modelLocked).toBe(false);
                restored?.changeModel({ effort: "high", modelId: "anthropic/test" });

                const snapshot = restored?.snapshot();
                const events = restored?.events.since(undefined) ?? [];
                expect(snapshot).toMatchObject({
                    effort: "high",
                    modelId: "anthropic/test",
                    modelLocked: false,
                    providerId: "claude",
                });
                expect(events.at(-1)).toMatchObject({
                    data: {
                        effort: "high",
                        modelId: "anthropic/test",
                    },
                    type: "session_configuration_changed",
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a forked conversation under a new session", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            const source = store.create({ cwd: "/tmp/rig-persistent-session-test" });
            const state = source.state();
            const message = textUserMessage("message-1", "Preserve this conversation.");
            store.upsertMessage(source.id, {
                isPartial: false,
                message,
                position: 0,
                runId: "run-1",
            });
            store.close();

            const forkStore = new PersistentSessionStore({ databasePath });
            const forked = forkStore.fork(state.id);
            expect(forked?.id).not.toBe(state.id);
            expect(forked?.snapshot().snapshot.messages).toEqual([message]);
            const forkedId = forked?.id;
            forkStore.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(forkedId).toBeDefined();
                expect(restoredStore.get(forkedId ?? "")?.snapshot().snapshot.messages).toEqual([
                    message,
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("repairs interrupted title generation on restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(
                sessionState({
                    titleStatus: "generating",
                }),
            );
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const summary = restoredStore.list({ limit: 1 }).at(0);

                expect(summary).toMatchObject({
                    titleStatus: "error",
                });
                expect(summary?.titleError).toContain("interrupted");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("persists subagent lineage while keeping child histories out of the main list", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(sessionState());
            store.saveSession(
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect the persistence layer",
                        parentSessionId: "session-1",
                        parentToolCallId: "tool-1",
                        rootSessionId: "session-1",
                        taskName: "inspect_persistence",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    activeSince: 1_500,
                    elapsedMs: 2_500,
                    id: "subagent-1",
                    status: "completed",
                    title: "Inspect the persistence layer",
                    titleStatus: "ready",
                    totalTokens: 12_345,
                    sessionTokenCount: {
                        lastContextTokens: 12_345,
                        totalTokens: 18_000,
                    },
                    usage: {
                        cacheRead: 9_000,
                        cacheWrite: 1_000,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 4_000,
                        output: 1_000,
                        totalTokens: 15_000,
                    },
                }),
            );
            store.saveSession(
                sessionState({
                    agent: {
                        depth: 2,
                        description: "Inspect the nested query",
                        parentSessionId: "subagent-1",
                        rootSessionId: "session-1",
                        taskName: "inspect_nested_query",
                        type: "subagent",
                    },
                    agentId: "agent-3",
                    elapsedMs: 900,
                    id: "subagent-2",
                    status: "error",
                    totalTokens: 600,
                }),
            );
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                expect(restoredStore.list().map((session) => session.id)).toEqual(["session-1"]);
                expect(restoredStore.listSubagents("session-1")).toEqual([
                    expect.objectContaining({
                        activeSince: 1_500,
                        depth: 1,
                        description: "Inspect the persistence layer",
                        elapsedMs: 2_500,
                        id: "subagent-1",
                        parentToolCallId: "tool-1",
                        status: "completed",
                        taskName: "inspect_persistence",
                        totalTokens: 12_345,
                        sessionTokenCount: {
                            lastContextTokens: 12_345,
                            totalTokens: 18_000,
                        },
                        usage: expect.objectContaining({
                            cacheRead: 9_000,
                            cacheWrite: 1_000,
                            input: 4_000,
                            output: 1_000,
                            totalTokens: 15_000,
                        }),
                    }),
                    expect.objectContaining({
                        depth: 2,
                        elapsedMs: 900,
                        id: "subagent-2",
                        parentSessionId: "subagent-1",
                        status: "error",
                        totalTokens: 600,
                    }),
                ]);
                expect(restoredStore.listSubagents("subagent-1")).toEqual([
                    expect.objectContaining({ id: "subagent-2" }),
                ]);
                expect(restoredStore.get("subagent-1")?.snapshot().agent).toEqual({
                    depth: 1,
                    description: "Inspect the persistence layer",
                    parentSessionId: "session-1",
                    parentToolCallId: "tool-1",
                    rootSessionId: "session-1",
                    taskName: "inspect_persistence",
                    type: "subagent",
                });
                expect(() =>
                    restoredStore.get("subagent-1")?.requestUserInput({
                        requestId: "question-1",
                        questions: [],
                    }),
                ).toThrow("Only the primary session");
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("drops a stored position from a subagent instead of listing it as a chat", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = new PersistentSessionStore({ databasePath });
            store.saveSession(sessionState());
            // A position written by an older build, when a subagent was given a
            // key of its own. It is still not a chat in any list.
            store.saveSession(
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect the ordering",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    orderKey: "a1",
                    status: "completed",
                }),
            );
            store.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const subagent = restoredStore.get("subagent-1");

                expect(subagent?.snapshot().orderKey).toBeUndefined();
                expect(subagent?.summary().orderKey).toBeUndefined();
                expect(restoredStore.list().map((session) => session.id)).toEqual(["session-1"]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await cleanup();
        }
    });
});

async function waitForExternalToolCall(session: InMemorySession) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const call = session.externalToolCalls({ status: "pending" })[0];
        if (call !== undefined) return call;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for the external function call.");
}

async function waitForPendingUserInputs(session: InMemorySession, count: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const requests = session.snapshot().pendingUserInputs;
        if (requests.length === count) return requests;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for the durable user question.");
}

function sessionMetadataResponse(request: GymInferenceRequest): Response | undefined {
    if (!request.options.sessionId?.endsWith(":title")) return undefined;
    return new Response(
        JSON.stringify({
            content: [
                {
                    text: JSON.stringify({
                        recap: "The session metadata reflects the visible conversation.",
                        title: "Generated Session Title",
                    }),
                    type: "text",
                },
            ],
            stopReason: "stop",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
    );
}

async function createDatabasePath(): Promise<{
    cleanup: () => Promise<void>;
    databasePath: string;
}> {
    const directory = await mkdtemp(join(tmpdir(), "rig-sessions-test-"));
    return {
        cleanup: () => rm(directory, { force: true, recursive: true }),
        databasePath: join(directory, "sessions.sqlite"),
    };
}

async function createGitRepository(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await execFile("git", ["-C", path, "init", "--initial-branch=main"]);
    await execFile("git", ["-C", path, "config", "user.email", "rig@example.test"]);
    await execFile("git", ["-C", path, "config", "user.name", "Rig Test"]);
    await writeFile(join(path, "README.md"), "fixture\n");
    await execFile("git", ["-C", path, "add", "README.md"]);
    await execFile("git", ["-C", path, "commit", "-m", "Initial"]);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function testModelCatalog(): ModelCatalog {
    const openai = defineModel({
        id: "openai/test",
        name: "OpenAI Test",
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "low",
    });
    const anthropic = defineModel({
        id: "anthropic/test",
        name: "Anthropic Test",
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "low",
    });
    return {
        defaultModelId: openai.id,
        defaultProviderId: "codex",
        models: [openai, anthropic],
        providers: [
            { providerId: "codex", models: [openai] },
            { providerId: "claude", models: [anthropic] },
        ],
    };
}

function sessionState(overrides: Partial<PersistedSessionState> = {}): PersistedSessionState {
    return {
        agent: {
            depth: 0,
            rootSessionId: "session-1",
            type: "primary",
        },
        agentId: "agent-1",
        cwd: "/tmp/rig-persistent-session-test",
        id: "session-1",
        messages: [],
        modelId: "openai/gpt-5.5",
        models: [],
        orderKey: "a0",
        providerId: "codex",
        permissionMode: "workspace_write",
        queuedRuns: [],
        nextTaskId: 1,
        status: "idle",
        tasks: [],
        titleStatus: "idle",
        tools: [],
        ...overrides,
    };
}

function textUserMessage(id: string, text: string): UserMessage {
    return {
        blocks: [{ text, type: "text" }],
        id,
        role: "user",
    };
}

function providerMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .flatMap((block) =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string"
                ? [block.text]
                : [],
        )
        .join("\n");
}

function sessionEvent(
    sessionId: string,
    id: string,
    type: SessionEvent["type"],
    data: unknown,
): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data,
        id,
        sessionId,
        type,
    } as SessionEvent;
}

function insertSessionEvent(
    database: DatabaseSync,
    sessionId: string,
    id: string,
    type: SessionEvent["type"],
    data: unknown,
): void {
    const record = data as Record<string, unknown>;
    const message = record.message as { id?: unknown } | undefined;
    const inner = record.event as { toolCallId?: unknown } | undefined;
    database
        .prepare(
            `
            INSERT INTO session_events (
                session_id, event_id, type, created_at_ms, data_json,
                run_id, message_id, tool_call_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
        )
        .run(
            sessionId,
            id,
            type,
            1_700_000_000_000,
            JSON.stringify(data),
            typeof record.runId === "string" ? record.runId : null,
            typeof message?.id === "string" ? message.id : null,
            typeof inner?.toolCallId === "string" ? inner.toolCallId : null,
        );
}

function insertEvent<TType extends import("../../protocol/index.js").SessionEvent["type"]>(
    database: DatabaseSync,
    sessionId: string,
    eventId: string,
    type: TType,
    createdAt: number,
    data: Extract<import("../../protocol/index.js").SessionEvent, { type: TType }>["data"],
): void {
    database
        .prepare(
            "INSERT INTO session_events (session_id, event_id, type, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, eventId, type, createdAt, JSON.stringify(data));
}
