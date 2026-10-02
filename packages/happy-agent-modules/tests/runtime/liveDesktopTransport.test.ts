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
    type SessionRunRequest,
} from "@slopus/happy-providers";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import { startHappyAgentRuntime } from "../../sources/runtime/startHappyAgentRuntime.js";
import * as liveProvider from "../../sources/live/impl/liveProviderTransport.js";
import { ScriptedProvider, ScriptedSession } from "../support/ScriptedProvider.js";
import { LIVE_VOICE_INSTRUCTIONS } from "../../sources/live/impl/livePrompts.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});

it.each([
    [false, false],
    [true, false],
    [true, true],
])(
    "runs authenticated Live HTTP, real provider/control WebSockets, sequential actions and staged results through the complete runtime (native: %s, lost controller: %s)",
    async (native, lostController) => {
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
            '[providers.controller]\ntype="codex"\nenabled=true\n[providers.voice]\ntype="codex"\nenabled=true\n',
        );
        bootstrap.closeProviders();
        const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
        const controller = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "open", name: "desktopOpen" },
                {
                    type: "toolcall_end",
                    callId: "open",
                    arguments: JSON.stringify({ target: { kind: "session", ...target } }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            [
                { type: "toolcall_start", callId: "state", name: "desktopState" },
                { type: "toolcall_end", callId: "state", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            [
                { type: "toolcall_start", callId: "stage", name: "sessionSend" },
                {
                    type: "toolcall_end",
                    callId: "stage",
                    arguments: JSON.stringify({ target, text: "Please inspect the failing test." }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            [
                {
                    type: "text_delta",
                    delta: "The exact message is staged. Review it and press Send.",
                },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
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
            inference: {
                providers,
                models: [
                    {
                        id: "fixture/controller",
                        name: "Controller fixture",
                        providerId: "controller",
                        defaultEffort: "low",
                        effortLevels: ["low"],
                    },
                ],
            },
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
                connections: [{ connectionId: "connection", name: "Fixture", online: true }],
                activeConnectionId: "connection",
                activeTarget: { kind: "session", ...target },
                projects: [],
                workspaces: [],
                bots: [],
                sessions: [{ target, title: "Fixture", status: "idle" }],
                activeSession: {
                    target,
                    status: "idle",
                    messages: [],
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
                action: { type: "desktopOpen" },
                contextRevision: 1,
            });
        const open = frames.find((frame) => frame.type === "actionRequested");
        if (open?.type !== "actionRequested") throw new Error("Missing open action.");
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
            await expect
                .poll(() => providerFrames)
                .toContainEqual(
                    expect.objectContaining({
                        type: "delegation.context.append",
                        delegation_item_id: "overlap",
                    }),
                );
        }
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
            .toHaveLength(2);
        const state = frames.filter((frame) => frame.type === "actionRequested")[1]!;
        expect(state).toMatchObject({ contextRevision: 2, action: { type: "desktopState" } });
        socket.send(
            JSON.stringify({
                type: "actionResult",
                actionId: state.actionId,
                result: { status: "succeeded", output: { type: "context", context: body.context } },
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
                                      text: "The exact message is staged. Review it and press Send.",
                                  },
                              ],
                          }
                        : {
                              type: "session.commentary.append",
                              delegation_id: "delegation_fixture",
                              content: "The exact message is staged. Review it and press Send.",
                          },
                ),
            );
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
        expect(JSON.stringify(journal)).not.toContain("Stage a test investigation request");
        expect(providerRequests).toHaveLength(1);
        const captured = controller.sessions.find((session) =>
            session.id.startsWith("live-controller:"),
        );
        expect(captured?.options.tools).toHaveLength(9);
        expect(captured?.requests[0]?.model).toBe("fixture/controller");
        expect(snapshots).toHaveLength(4);
        expect(JSON.stringify(snapshots[0])).not.toContain('"tool_call"');
        if (!native && process.env.HAPPY_LIVE_CAPTURE_FILE !== undefined) {
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
