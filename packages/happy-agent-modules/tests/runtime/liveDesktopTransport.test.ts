import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import {
    HappyAgentClient,
    type CreateLiveSessionRequest,
    type LiveControlServerMessage,
} from "@slopus/happy-agent-client";
import {
    CodexProvider,
    CodexApiKeyCredential,
    CodexSessionCredential,
    type SessionEvent,
    type SessionRunRequest,
} from "@slopus/happy-providers";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import { startHappyAgentRuntime } from "../../sources/runtime/startHappyAgentRuntime.js";
import * as liveProvider from "../../sources/live/impl/liveProviderTransport.js";
import { ScriptedProvider, ScriptedSession } from "../support/ScriptedProvider.js";
import {
    LIVE_LATER_REQUEST_INSTRUCTIONS,
    LIVE_QUEUED_REQUEST_INSTRUCTIONS,
    LIVE_VOICE_INSTRUCTIONS,
} from "../../sources/live/impl/livePrompts.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});

it.each([
    [false, false, false, false],
    [true, false, false, false],
    [true, true, false, false],
    [false, false, true, false],
    [false, false, false, true],
    [true, false, false, true],
])(
    "runs authenticated Live HTTP, real provider/control WebSockets, sequential actions and staged results through the complete runtime (native: %s, lost controller: %s, smart default: %s, recover controller: %s)",
    async (native, lostController, smartDefault, recoverController) => {
        const snapshots: SessionRunRequest[] = [];
        const actualRun = ScriptedSession.prototype.run;
        vi.spyOn(ScriptedSession.prototype, "run").mockImplementation(
            function (this: ScriptedSession, ctx, request) {
                snapshots.push(structuredClone(request));
                return actualRun.call(this, ctx, request);
            },
        );
        const root = await mkdtemp(join(tmpdir(), "happy-live-runtime-"));
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const happyHome = join(root, ".happy");
        await writeFile(
            join(root, "auth.json"),
            JSON.stringify({ tokens: { access_token: "fixture-only-key" } }),
        );
        const bootstrap = await ConfigModule.load(happyHome);
        await mkdir(dirname(bootstrap.configuration.paths.globalConfigPath), { recursive: true });
        await writeFile(
            bootstrap.configuration.paths.globalConfigPath,
            '[providers.controller]\ntype="codex"\nenabled=true\n' +
                (smartDefault
                    ? 'hidden=true\n[providers.controller_pool]\ntype="smart"\nproviders=["controller"]\nenabled=true\n'
                    : "") +
                '[providers.voice]\ntype="codex"\nenabled=true\n',
        );
        bootstrap.closeProviders();
        const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
        const controller = new ScriptedProvider([
            // Voice's opening turn, when the first call creates it.
            [
                { type: "text_start" },
                { type: "text_delta", delta: "Ready." },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            ...(recoverController
                ? [
                      [
                          {
                              type: "done",
                              state: "error",
                              kind: "unknown",
                              message: "Private provider diagnostic sentinel",
                          } as const,
                      ],
                  ]
                : []),
            [
                { type: "toolcall_start", callId: "state", name: "desktopState" },
                { type: "toolcall_end", callId: "state", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            // One response batches the open with the staging that needs the opened conversation.
            [
                { type: "toolcall_start", callId: "open", name: "desktopOpen" },
                {
                    type: "toolcall_end",
                    callId: "open",
                    arguments: JSON.stringify({ target: { kind: "session", ...target } }),
                },
                { type: "toolcall_start", callId: "stage", name: "sessionSend" },
                {
                    type: "toolcall_end",
                    callId: "stage",
                    arguments: JSON.stringify({ target, text: "Please inspect the failing test." }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            [
                { type: "text_start" },
                {
                    type: "text_delta",
                    delta: "The exact message is staged. Review it and press Send.",
                },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            // The native follow-up is queued behind the staging request, so its turn comes last.
            ...(native
                ? [
                      [
                          { type: "text_start" } as const,
                          { type: "text_delta", delta: "Independent overlap complete." } as const,
                          { type: "text_end" } as const,
                          {
                              type: "done",
                              state: "normal",
                              tokens: { input: 1, output: 1 },
                          } as const,
                      ],
                  ]
                : []),
        ]);
        const providers = new AgentProviders();
        providers.add("controller", controller, "codex");
        providers.add(
            "voice",
            new CodexProvider({
                credential: native
                    ? CodexSessionCredential.fromAuth(
                          { accessToken: "fixture-only-key" },
                          { authFile: join(root, "auth.json") },
                      )
                    : (await CodexApiKeyCredential.tryLoad({ apiKey: "fixture-only-key" }))!,
            }),
            "codex",
        );
        const providerFrames: unknown[] = [];
        const providerRequests: unknown[] = [];
        const providerSockets: WebSocket[] = [];
        const upstream = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            providerRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
            if (native) {
                response.writeHead(201, {
                    location: "/v1/live/rtc_fixture",
                    "content-type": "application/sdp",
                });
                response.end("v=fixture-answer");
                return;
            }
            response.writeHead(201, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    session: { id: "sess_fixture" },
                    transport: { type: "webrtc", sdp: "v=fixture-answer" },
                }),
            );
        });
        const upstreamWs = new WebSocketServer({ server: upstream });
        upstreamWs.on("connection", (socket) => {
            providerSockets.push(socket);
            socket.on("message", (data) => {
                const frame = JSON.parse(data.toString());
                providerFrames.push(frame);
                if (!native && frame.type === "session.close")
                    socket.send(
                        JSON.stringify({
                            type: "session.closed",
                            session: { id: "sess_fixture" },
                            reason: "close_requested",
                            usage: { seconds: 17 },
                        }),
                    );
            });
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        const address = upstream.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture address.");
        const upstreamOrigin = `http://127.0.0.1:${address.port}`;
        cleanups.push(async () => {
            for (const socket of upstreamWs.clients) socket.terminate();
            upstreamWs.close();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        });
        const actualCreate = liveProvider.createLiveProviderTransport;
        vi.spyOn(liveProvider, "createLiveProviderTransport").mockImplementation((options) =>
            actualCreate(options, {
                fetch: async (url, init) => {
                    expect(String(url)).toBe(
                        native
                            ? "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
                            : "https://api.openai.com/v1/live/sessions",
                    );
                    return fetch(upstreamOrigin, init);
                },
                connect: (url, headers) => {
                    expect(url).toBe(
                        native
                            ? "wss://api.openai.com/v1/live/rtc_fixture"
                            : "wss://api.openai.com/v1/live/sessions/sess_fixture/attach",
                    );
                    return new WebSocket(upstreamOrigin.replace("http:", "ws:"), { headers });
                },
                setupTimeoutMs: 30000,
                readyTimeoutMs: 30000,
                closeTimeoutMs: 15000,
            }),
        );
        const runtime = await startHappyAgentRuntime({
            happyHome,
            inference: () => ({
                providers,
                models: [
                    {
                        id: smartDefault ? "openai/gpt-6-astra" : "fixture/controller",
                        name: "Controller fixture",
                        providerId: smartDefault ? "controller_pool" : "controller",
                        defaultEffort: "low",
                        effortLevels: ["low"],
                    },
                    {
                        id: "openai/gpt-6.1-sol",
                        name: "GPT-6.1 Sol controller fixture",
                        providerId: smartDefault ? "controller_pool" : "controller",
                        defaultEffort: "low",
                        effortLevels: ["low"],
                    },
                ],
            }),
        });
        cleanups.push(() => runtime.close());
        const http = createServer((request, response) => {
            void runtime.api.handleRequest(
                withAgentDatabase(runtime.ctx.named("live-http-test"), runtime.database),
                request,
                response,
            );
        });
        http.on("upgrade", (request, socket, head) => {
            void runtime.api.handleUpgrade(
                withAgentDatabase(runtime.ctx.named("live-upgrade-test"), runtime.database),
                request,
                socket as import("node:net").Socket,
                head,
            );
        });
        await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
        const apiAddress = http.address();
        if (apiAddress === null || typeof apiAddress === "string")
            throw new Error("Missing API address.");
        const origin = `http://127.0.0.1:${apiAddress.port}`;
        cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
        const token = (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim();
        const client = new HappyAgentClient({ endpoint: origin, token });
        expect((await fetch(`${origin}/v0/health`)).status).toBe(401);
        expect(
            await (
                await fetch(`${origin}/v0/health`, {
                    headers: { authorization: `Bearer ${token}` },
                })
            ).json(),
        ).toMatchObject({ capabilities: { desktopLiveControl: true } });
        const body: CreateLiveSessionRequest = {
            id: "livefixture",
            windowId: "window-fixture",
            credential: {
                type: native ? "codex_subscription" : "openai_api_key",
                providerId: "voice",
            },
            sdp: "v=fixture-offer",
            contextRevision: 1,
            context: {
                windowId: "window-fixture",
                connections: [
                    {
                        connectionId: "connection",
                        name: "Private connection label sentinel",
                        online: true,
                    },
                ],
                activeConnectionId: "connection",
                activeTarget: { kind: "session", ...target },
                projects: [],
                workspaces: [],
                bots: [],
                sessions: [{ target, title: "Private session title sentinel", status: "idle" }],
                activeSession: {
                    target,
                    status: "idle",
                    messages: [
                        {
                            id: "public-message",
                            role: "user",
                            text: "Private public message sentinel",
                        },
                    ],
                    composerHasDraft: false,
                    writeRefusal: null,
                },
                truncated: false,
            },
        };
        const created = await client.createLiveSession(body);
        expect(created).toMatchObject({
            session: { status: "starting" },
            transport: { sdp: "v=fixture-answer" },
        });
        expect(providerRequests).toHaveLength(1);
        const frames: LiveControlServerMessage[] = [];
        const socket = new WebSocket(
            `${origin.replace("http:", "ws:")}/v0/live/sessions/livefixture/control?windowId=window-fixture`,
            { headers: { authorization: `Bearer ${token}` } },
        );
        cleanups.push(() => socket.terminate());
        socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
        await expect
            .poll(() => frames[0])
            .toMatchObject({
                type: "hello",
                sessionId: "livefixture",
                windowId: "window-fixture",
                contextRevision: 1,
            });
        providerSockets[0]!.send(
            JSON.stringify({ type: "session.started", session: { id: "sess_fixture" } }),
        );
        await expect
            .poll(async () => (await client.getLiveSession("livefixture")).session.status)
            .toBe("active");
        if (recoverController) {
            providerSockets[0]!.send(
                JSON.stringify(
                    native
                        ? {
                              type: "delegation.created",
                              item: {
                                  id: "failed_delegation",
                                  type: "delegation",
                                  target: "client",
                                  content: [{ type: "input_text", text: "Read the desktop" }],
                              },
                          }
                        : {
                              type: "session.delegation.created",
                              delegation: {
                                  id: "failed_delegation",
                                  type: "delegation",
                                  target: "client",
                              },
                          },
                ),
            );
            await expect
                .poll(() => providerFrames)
                .toContainEqual(
                    expect.objectContaining(
                        native
                            ? {
                                  type: "delegation.context.append",
                                  delegation_item_id: "failed_delegation",
                                  channel: "speakable",
                                  content: [
                                      {
                                          type: "input_text",
                                          text: expect.stringContaining("could not complete"),
                                      },
                                  ],
                              }
                            : {
                                  type: "session.commentary.append",
                                  delegation_id: "failed_delegation",
                                  content: expect.stringContaining("could not complete"),
                              },
                    ),
                );
            expect((await client.getLiveSession("livefixture")).session).toMatchObject({
                status: "active",
                error: null,
            });
            expect(
                frames.some((frame) => frame.type === "status" && frame.status === "failed"),
            ).toBe(false);
            expect(frames.some((frame) => frame.type === "actionRequested")).toBe(false);
            expect(JSON.stringify(providerFrames)).not.toContain("Private provider diagnostic");
        }
        providerSockets[0]!.send(
            JSON.stringify(
                native
                    ? {
                          type: "input_transcript.added",
                          item: {
                              type: "input_transcript",
                              id: "initial",
                              text: "Stage a test investigation request",
                          },
                      }
                    : {
                          type: "session.input_transcript.delta",
                          delta: "Stage a test investigation request",
                          start_ms: 0,
                          end_ms: 100,
                      },
            ),
        );
        if (native) {
            // More than the old lifetime cap, with real provider and desktop WebSocket frames.
            for (let index = 0; index < 350; index++) {
                providerSockets[0]!.send(
                    JSON.stringify({
                        type: "input_transcript.added",
                        item: { type: "input_transcript", id: `fragment-${index}`, text: "more" },
                    }),
                );
                await expect
                    .poll(() => frames.filter((frame) => frame.type === "transcript").length, {
                        interval: 1,
                    })
                    .toBe(index + 2);
            }
        }
        providerSockets[0]!.send(
            JSON.stringify(
                native
                    ? {
                          type: "delegation.created",
                          item: {
                              id: "delegation_fixture",
                              type: "delegation",
                              target: "client",
                              content: [
                                  {
                                      type: "input_text",
                                      text: "Open the conversation then stage the message",
                                  },
                              ],
                          },
                      }
                    : {
                          type: "session.delegation.created",
                          delegation: {
                              id: "delegation_fixture",
                              type: "delegation",
                              target: "client",
                          },
                      },
            ),
        );
        await expect
            .poll(() => frames.find((frame) => frame.type === "actionRequested"))
            .toMatchObject({
                action: { type: "desktopState" },
                contextRevision: 1,
            });
        const state = frames.find((frame) => frame.type === "actionRequested");
        if (state?.type !== "actionRequested") throw new Error("Missing state action.");
        if (native) {
            providerSockets[0]!.send(
                JSON.stringify({
                    type: "delegation.created",
                    item: {
                        id: "overlap",
                        type: "delegation",
                        target: "client",
                        content: [{ type: "input_text", text: "Another request" }],
                    },
                }),
            );
        }
        socket.send(
            JSON.stringify({
                type: "actionResult",
                actionId: state.actionId,
                result: { status: "succeeded", output: { type: "context", context: body.context } },
            }),
        );
        await expect
            .poll(() => frames.filter((frame) => frame.type === "actionRequested"))
            .toHaveLength(2);
        const open = frames.filter((frame) => frame.type === "actionRequested")[1]!;
        expect(open).toMatchObject({ contextRevision: 1, action: { type: "desktopOpen" } });
        // Navigation advances the revision; the batch's next action carries the accepted one.
        socket.send(JSON.stringify({ type: "desktopContext", revision: 2, context: body.context }));
        socket.send(
            JSON.stringify({
                type: "actionResult",
                actionId: open.actionId,
                result: { status: "succeeded", output: { type: "ack" } },
            }),
        );
        await expect
            .poll(() => frames.filter((frame) => frame.type === "actionRequested"))
            .toHaveLength(3);
        const action = frames.filter((frame) => frame.type === "actionRequested")[2];
        if (action?.type !== "actionRequested") throw new Error("Missing desktop action.");
        expect(action).toMatchObject({
            contextRevision: 2,
            action: { type: "sessionSend", target, text: "Please inspect the failing test." },
        });
        expect(action.inputTranscriptIds).toHaveLength(native ? 32 : 1);
        socket.send(
            JSON.stringify({
                type: "actionResult",
                actionId: action.actionId,
                result: { status: "succeeded", output: { type: "staged" } },
            }),
        );
        socket.send(
            JSON.stringify({
                type: "actionResult",
                actionId: action.actionId,
                result: { status: "succeeded", output: { type: "staged" } },
            }),
        );
        await expect
            .poll(() => providerFrames)
            .toContainEqual(
                expect.objectContaining(
                    native
                        ? {
                              type: "delegation.context.append",
                              delegation_item_id: "delegation_fixture",
                              channel: "speakable",
                              content: [
                                  {
                                      type: "input_text",
                                      text: `The exact message is staged. Review it and press Send.\n\n${LIVE_QUEUED_REQUEST_INSTRUCTIONS}`,
                                  },
                              ],
                          }
                        : {
                              type: "session.commentary.append",
                              delegation_id: "delegation_fixture",
                              content: `The exact message is staged. Review it and press Send.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
                          },
                ),
            );
        if (native) {
            const delivery = (delegation: string) =>
                providerFrames.findIndex(
                    (frame) =>
                        (frame as { delegation_item_id?: string }).delegation_item_id ===
                        delegation,
                );
            await expect.poll(() => delivery("overlap")).toBeGreaterThan(-1);
            expect(providerFrames[delivery("overlap")]).toMatchObject({
                type: "delegation.context.append",
                channel: "speakable",
                content: [
                    {
                        type: "input_text",
                        text: `Independent overlap complete.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
                    },
                ],
            });
            // Queued, not concurrent: the follow-up answers only after the staging request finishes.
            expect(delivery("overlap")).toBeGreaterThan(delivery("delegation_fixture"));
            expect(frames.filter((frame) => frame.type === "actionRequested")).toHaveLength(3);
        }
        if (lostController) socket.terminate();
        else {
            await client.closeLiveSession("livefixture");
            socket.close();
        }
        await expect
            .poll(async () => (await client.getLiveSession("livefixture")).session)
            .toMatchObject({
                status: lostController ? "failed" : "closed",
                usage: native ? { seconds: null, final: false } : { seconds: 17, final: true },
            });
        if (lostController)
            expect((await client.getLiveSession("livefixture")).session.error).toBe(
                "The desktop controller disconnected.",
            );
        const journal = await client.getEvents();
        expect(JSON.stringify(journal)).not.toContain("fixture-only-key");
        expect(JSON.stringify(journal)).not.toContain("v=fixture-offer");
        // Speech is kept only in the person's Voice conversation, never anywhere else.
        const voice = await runtime.modules.live.voiceAgent(
            withAgentDatabase(runtime.ctx.named("live-test-voice"), runtime.database),
            "standalone",
        );
        if (voice === undefined) throw new Error("The call did not create Voice.");
        const mentions = journal.events
            .map((event) => JSON.stringify(event))
            .filter((event) => event.includes("Stage a test investigation request"));
        // The native call's later speech pushes the first fragment out of the bounded window.
        if (!native) expect(mentions.length).toBeGreaterThan(0);
        expect(mentions.every((event) => event.includes(voice))).toBe(true);
        expect(providerRequests).toHaveLength(1);
        const used = controller.sessions.filter((session) => session.requests.length > 0);
        // Voice's opening turn runs on the pool; its requests run on the account the call froze.
        expect(used).toHaveLength(smartDefault ? 2 : 1);
        const captured = used.at(-1);
        expect(captured?.options.tools?.map((tool) => tool.name)).toEqual([
            "list_sidebar",
            "read_conversations",
            "desktopState",
            "desktopOpen",
            "sessionRead",
            "sessionSend",
            "composerDraftAppend",
        ]);
        expect(
            captured?.requests.every(
                (request) => request.model === "openai/gpt-6.1-sol" && request.effort === "low",
            ),
        ).toBe(true);
        expect(snapshots).toHaveLength(1 + (recoverController ? 4 : 3) + (native ? 1 : 0));
        expect(JSON.stringify(snapshots[0])).not.toContain('"tool_call"');
        await runtime.modules.observation.flush();
        const localLog = await readFile(runtime.configuration.paths.logPath, "utf8");
        const voiceLogs = localLog
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((record) => record.voiceSessionId === "livefixture")
            .map((record) => JSON.parse(record.msg));
        expect(voiceLogs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    event: "session.created",
                    controllerProviderId: "controller",
                    model: "openai/gpt-6.1-sol",
                }),
                expect.objectContaining({ event: "control.attached" }),
                expect.objectContaining({
                    event: "transcript.received",
                    role: "user",
                    characters: 34,
                }),
                expect.objectContaining({
                    event: "context.accepted",
                    contextRevision: 2,
                    context: expect.objectContaining({ activeSession: target }),
                }),
                expect.objectContaining({
                    event: "action.requested",
                    actionId: action.actionId,
                    actionType: "sessionSend",
                    contextRevision: 2,
                }),
                expect.objectContaining({
                    event: "action.result",
                    actionId: action.actionId,
                    resultStatus: "succeeded",
                    outputType: "staged",
                }),
                expect.objectContaining({
                    event: "session.status",
                    status: lostController ? "failed" : "closed",
                }),
            ]),
        );
        if (recoverController)
            expect(voiceLogs).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        event: "controller.failed",
                        delegationId: "failed_delegation",
                        category: "inference",
                        detail: expect.objectContaining({
                            reason: "providerError",
                            providerErrorKind: "unknown",
                        }),
                    }),
                ]),
            );
        expect(localLog).not.toContain("fixture-only-key");
        expect(localLog).not.toContain("v=fixture-offer");
        // Voice's own inference failures are logged like any agent's; voice diagnostics never are.
        expect(JSON.stringify(voiceLogs)).not.toContain("Private provider diagnostic");
        expect(localLog).not.toContain("Stage a test investigation request");
        expect(localLog).not.toContain("Please inspect the failing test.");
        expect(localLog).not.toContain("The exact message is staged.");
        expect(localLog).not.toContain("Private connection label sentinel");
        expect(localLog).not.toContain("Private session title sentinel");
        expect(localLog).not.toContain("Private public message sentinel");
        expect(localLog).not.toContain("Independent overlap complete.");
        expect(JSON.stringify(providerFrames)).not.toContain("previous request");
        if (native)
            expect(voiceLogs).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        event: "delegation.started",
                        delegationId: "overlap",
                    }),
                    expect.objectContaining({
                        event: "controller.finished",
                        delegationId: "overlap",
                    }),
                    expect.objectContaining({
                        event: "delegation.delivered",
                        delegationId: "overlap",
                    }),
                ]),
            );
        expect(
            voiceLogs.every((record) => Buffer.byteLength(JSON.stringify(record)) <= 32_768),
        ).toBe(true);
        if (recoverController)
            expect(
                voiceLogs.filter(
                    (record) =>
                        record.event === "controller.finished" &&
                        record.delegationId === "failed_delegation",
                ),
            ).toHaveLength(0);
        if (!native && !recoverController && process.env.HAPPY_LIVE_CAPTURE_FILE !== undefined) {
            await writeFile(
                process.env.HAPPY_LIVE_CAPTURE_FILE,
                JSON.stringify(
                    {
                        fixture:
                            "Sanitized real runtime controller requests snapshotted at each run entry; provider inference is scripted.",
                        voiceInstructions: LIVE_VOICE_INSTRUCTIONS,
                        providerId: "controller",
                        sessionOptions: captured!.options,
                        initialRequest: snapshots[0],
                        subsequentRequests: snapshots.slice(1),
                    },
                    null,
                    2,
                ),
            );
        }
    },
    30000,
);

it("queues a follow-up voice request behind the active desktop action and keeps one Voice conversation", async () => {
    const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
    const text = (value: string): SessionEvent[] => [
        { type: "block_start" },
        { type: "text_start" },
        { type: "text_delta", delta: value },
        { type: "text_end" },
        { type: "block_stop" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
    const tool = (callId: string, name: string, args: unknown): SessionEvent[] => [
        { type: "block_start" },
        { type: "reasoning_start" },
        { type: "reasoning_delta", delta: "Private controller reasoning sentinel" },
        { type: "reasoning_end" },
        { type: "block_stop" },
        { type: "block_start" },
        { type: "toolcall_start", callId, name },
        { type: "toolcall_end", callId, arguments: JSON.stringify(args) },
        { type: "block_stop" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
    // Answers depend on the request rather than call order, so concurrent and queued runs compare.
    const runs: { sessionId: string; request: SessionRunRequest }[] = [];
    vi.spyOn(ScriptedSession.prototype, "run").mockImplementation(
        function (this: ScriptedSession, _ctx, request) {
            runs.push({ sessionId: this.id, request: structuredClone(request) });
            const last = request.context.messages.at(-1);
            const callId = last?.role === "tool" ? (last as { callId?: string }).callId : undefined;
            const events =
                callId === "state"
                    ? text("Second outcome.")
                    : JSON.stringify(last).includes("Read the second desktop state")
                      ? tool("state", "desktopState", {})
                      : JSON.stringify(last).includes("Open the first conversation")
                        ? tool("open", "desktopOpen", { target: { kind: "session", ...target } })
                        : text("Unexpected controller request.");
            return (async function* () {
                yield* events;
            })();
        },
    );
    const root = await mkdtemp(join(tmpdir(), "happy-live-fifo-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const happyHome = join(root, ".happy");
    await writeFile(
        join(root, "auth.json"),
        JSON.stringify({ tokens: { access_token: "fixture-only-key" } }),
    );
    const bootstrap = await ConfigModule.load(happyHome);
    await mkdir(dirname(bootstrap.configuration.paths.globalConfigPath), { recursive: true });
    await writeFile(
        bootstrap.configuration.paths.globalConfigPath,
        '[providers.controller]\ntype="codex"\nenabled=true\n[providers.voice]\ntype="codex"\nenabled=true\n',
    );
    bootstrap.closeProviders();
    const controller = new ScriptedProvider([]);
    const providers = new AgentProviders();
    providers.add("controller", controller, "codex");
    providers.add(
        "voice",
        new CodexProvider({
            credential: CodexSessionCredential.fromAuth(
                { accessToken: "fixture-only-key" },
                { authFile: join(root, "auth.json") },
            ),
        }),
        "codex",
    );
    const providerFrames: unknown[] = [];
    const providerSockets: WebSocket[] = [];
    const upstream = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            response.writeHead(201, {
                location: "/v1/live/rtc_fixture",
                "content-type": "application/sdp",
            });
            response.end("v=fixture-answer");
        });
    });
    const upstreamWs = new WebSocketServer({ server: upstream });
    upstreamWs.on("connection", (socket) => {
        providerSockets.push(socket);
        socket.on("message", (data) => providerFrames.push(JSON.parse(data.toString())));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string")
        throw new Error("Missing fixture address.");
    const upstreamOrigin = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => {
        for (const socket of upstreamWs.clients) socket.terminate();
        upstreamWs.close();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const actualCreate = liveProvider.createLiveProviderTransport;
    vi.spyOn(liveProvider, "createLiveProviderTransport").mockImplementation((options) =>
        actualCreate(options, {
            fetch: async (_url, init) => fetch(upstreamOrigin, init),
            connect: (_url, headers) =>
                new WebSocket(upstreamOrigin.replace("http:", "ws:"), { headers }),
            setupTimeoutMs: 30000,
            readyTimeoutMs: 30000,
            closeTimeoutMs: 15000,
        }),
    );
    const runtime = await startHappyAgentRuntime({
        happyHome,
        inference: () => ({
            providers,
            models: [
                {
                    id: "fixture/controller",
                    name: "Ordinary default fixture",
                    providerId: "controller",
                    defaultEffort: "low",
                    effortLevels: ["low"],
                },
                {
                    id: "openai/gpt-6.1-sol",
                    name: "GPT-6.1 Sol controller fixture",
                    providerId: "controller",
                    defaultEffort: "low",
                    effortLevels: ["low"],
                },
            ],
        }),
    });
    cleanups.push(() => runtime.close());
    const http = createServer((request, response) => {
        void runtime.api.handleRequest(
            withAgentDatabase(runtime.ctx.named("live-http-test"), runtime.database),
            request,
            response,
        );
    });
    http.on("upgrade", (request, socket, head) => {
        void runtime.api.handleUpgrade(
            withAgentDatabase(runtime.ctx.named("live-upgrade-test"), runtime.database),
            request,
            socket as import("node:net").Socket,
            head,
        );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const apiAddress = http.address();
    if (apiAddress === null || typeof apiAddress === "string")
        throw new Error("Missing API address.");
    const origin = `http://127.0.0.1:${apiAddress.port}`;
    cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const token = (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim();
    const client = new HappyAgentClient({ endpoint: origin, token });
    const context: CreateLiveSessionRequest["context"] = {
        windowId: "window-fixture",
        connections: [{ connectionId: "connection", name: "Fixture", online: true }],
        activeConnectionId: "connection",
        activeTarget: { kind: "session", ...target },
        projects: [],
        workspaces: [],
        bots: [],
        sessions: [{ target, title: "Original session title", status: "idle" }],
        activeSession: {
            target,
            status: "idle",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        },
        truncated: false,
    };
    const fresh = structuredClone(context);
    fresh.sessions[0]!.title = "Fresh session title";
    await client.createLiveSession({
        id: "livefifo",
        windowId: "window-fixture",
        credential: { type: "codex_subscription", providerId: "voice" },
        sdp: "v=fixture-offer",
        contextRevision: 1,
        context,
    });
    const frames: LiveControlServerMessage[] = [];
    const socket = new WebSocket(
        `${origin.replace("http:", "ws:")}/v0/live/sessions/livefifo/control?windowId=window-fixture`,
        { headers: { authorization: `Bearer ${token}` } },
    );
    cleanups.push(() => socket.terminate());
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await expect.poll(() => frames[0]).toMatchObject({ type: "hello", sessionId: "livefifo" });
    const provider = (value: unknown) => providerSockets[0]!.send(JSON.stringify(value));
    const speech = (id: string, value: string) =>
        provider({
            type: "input_transcript.added",
            item: { type: "input_transcript", id, text: value },
        });
    const delegate = (id: string, value: string) =>
        provider({
            type: "delegation.created",
            item: {
                id,
                type: "delegation",
                target: "client",
                content: [{ type: "input_text", text: value }],
            },
        });
    const actions = () =>
        frames.filter(
            (frame): frame is Extract<LiveControlServerMessage, { type: "actionRequested" }> =>
                frame.type === "actionRequested",
        );
    const transcriptId = (value: string) => {
        const frame = frames.find((item) => item.type === "transcript" && item.text === value);
        return frame?.type === "transcript" ? frame.transcriptId : undefined;
    };
    provider({ type: "session.started", session: { id: "rtc_fixture" } });
    await expect
        .poll(async () => (await client.getLiveSession("livefifo")).session.status)
        .toBe("active");

    speech("first-speech", "Open the first conversation please");
    delegate("first_request", "Open the first conversation");
    await expect.poll(() => actions()).toHaveLength(1);
    expect(actions()[0]).toMatchObject({ contextRevision: 1, action: { type: "desktopOpen" } });

    speech("second-speech", "Then read the desktop");
    delegate("second_request", "Read the second desktop state");
    // Provider events are handled in order, so this later transcript proves the follow-up was accepted.
    speech("barrier-speech", "Barrier after the follow-up");
    await expect.poll(() => transcriptId("Barrier after the follow-up")).toBeDefined();
    expect(actions()).toHaveLength(1);

    socket.send(JSON.stringify({ type: "desktopContext", revision: 2, context: fresh }));
    await expect
        .poll(async () => (await client.getLiveSession("livefifo")).session.contextRevision)
        .toBe(2);
    expect(actions()).toHaveLength(1);
    expect(JSON.stringify(providerFrames)).not.toContain("busy");

    socket.send(
        JSON.stringify({
            type: "actionResult",
            actionId: actions()[0]!.actionId,
            result: { status: "succeeded", output: { type: "ack" } },
        }),
    );
    await expect.poll(() => actions()).toHaveLength(2);
    const second = actions()[1]!;
    expect(second).toMatchObject({ contextRevision: 2, action: { type: "desktopState" } });
    expect(second.actionId).not.toBe(actions()[0]!.actionId);
    expect(second.inputTranscriptIds).toContain(transcriptId("Then read the desktop"));
    expect(second.inputTranscriptIds).not.toContain(transcriptId("Barrier after the follow-up"));
    socket.send(
        JSON.stringify({
            type: "actionResult",
            actionId: second.actionId,
            result: { status: "succeeded", output: { type: "context", context: fresh } },
        }),
    );
    const delivered = (delegation: string, value: string, instructions: string) =>
        expect.objectContaining({
            type: "delegation.context.append",
            delegation_item_id: delegation,
            content: [{ type: "input_text", text: `${value}\n\n${instructions}` }],
        });
    await expect
        .poll(() => providerFrames)
        .toEqual(
            expect.arrayContaining([
                // The name is resolved when the outcome is spoken, from the desktop's newest context.
                delivered(
                    "first_request",
                    "Opened Fresh session title.",
                    LIVE_QUEUED_REQUEST_INSTRUCTIONS,
                ),
                delivered("second_request", "Second outcome.", LIVE_LATER_REQUEST_INSTRUCTIONS),
            ]),
        );
    expect(actions()).toHaveLength(2);

    // One Voice conversation, pinned to GPT-6.1 Sol at low effort.
    expect(new Set(runs.map((run) => run.sessionId)).size).toBe(1);
    expect(runs.every((run) => run.request.model === "openai/gpt-6.1-sol")).toBe(true);
    expect(runs.every((run) => run.request.effort === "low")).toBe(true);
    const followUp = runs.find(
        (run) =>
            run.request.context.messages.at(-1)?.role !== "tool" &&
            JSON.stringify(run.request.context.messages.at(-1)).includes(
                "Read the second desktop state",
            ),
    );
    if (followUp === undefined) throw new Error("Missing follow-up Voice request.");
    // Voice remembers the earlier request, and is handed only speech it has not seen.
    const latest = JSON.stringify(followUp.request.context.messages.at(-1));
    expect(latest).toContain("Then read the desktop");
    expect(latest).not.toContain("Open the first conversation please");
    expect(JSON.stringify(followUp.request.context.messages.slice(0, -1))).toContain(
        "Open the first conversation please",
    );

    await client.closeLiveSession("livefifo");
    await expect
        .poll(async () => (await client.getLiveSession("livefifo")).session.status)
        .toBe("closed");
}, 30000);
