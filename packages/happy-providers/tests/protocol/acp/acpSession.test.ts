import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@sinclair/typebox";
import { createRootContext, withLifetime, withLogger } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionMessage, SessionSystemMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import {
    AcpProvider,
    type AcpAgentProfile,
    type AcpPermissionMode,
    type AcpPermissionQuestion,
    type AcpTurnEnvironment,
} from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { acpDiscoverModels } from "@/protocol/acp/acpDiscoverModels.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import {
    acpSessionRecordClear,
    acpSessionRecordRead,
    acpSessionRecordWrite,
} from "@/protocol/acp/impl/acpSessionStore.js";
import type * as acp from "@agentclientprotocol/sdk";
import { acpConfigOptionId } from "@/protocol/acp/impl/acpConfigOptions.js";
import { acpGenericAgent } from "@/vendors/foreignAgents/acpGenericAgent.js";
import { antigravityAgent } from "@/vendors/foreignAgents/antigravityAgent.js";

const AGENT = fileURLToPath(new URL("./fixtures/scriptedAcpAgent.mjs", import.meta.url));
const tools = [
    {
        name: "happy_secret",
        description: "Returns the secret.",
        parameters: Type.Object({ why: Type.Optional(Type.String({ pattern: "^[^\\u0000]*$" })) }),
    },
];

const open: AcpSession[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((session) => session.destroy()));
});

function harness(
    options: {
        steerable?: boolean;
        profile?: AcpAgentProfile;
        tools?: readonly SessionTool[];
        askPermission?: AcpTurnEnvironment["askPermission"];
        wake?: AcpTurnEnvironment["wake"];
    } = {},
) {
    const directory = mkdtempSync(join(tmpdir(), "acp-session-"));
    const logPath = join(directory, "agent.jsonl");
    let permissionMode: AcpPermissionMode = "auto";
    const launch = {
        command: process.execPath,
        args: [AGENT],
        env: { SCRIPTED_ACP_LOG: logPath },
    };
    const provider = new AcpProvider({
        launch,
        // A first-party driver offers mid-turn input; the fixture stands in for it over ACP.
        ...(options.steerable === true
            ? {
                  connect: async (cwd: string, client: acp.Client) => {
                      const connection = await acpConnectionSpawn(launch, cwd, client);
                      const conn = connection.conn as acp.ClientSideConnection;
                      return {
                          ...connection,
                          conn: Object.assign(Object.create(conn) as typeof conn, {
                              steer: async (params: {
                                  sessionId: string;
                                  prompt: acp.ContentBlock[];
                              }) =>
                                  (
                                      await conn.extMethod("_happy/steer", {
                                          sessionId: params.sessionId,
                                          text: params.prompt
                                              .map((b) => (b.type === "text" ? b.text : ""))
                                              .join(""),
                                      })
                                  ).taken === true,
                          }),
                      };
                  },
              }
            : {}),
        stateDirectory: join(directory, "state"),
        environment: () => ({
            cwd: directory,
            permissionMode,
            ...(options.askPermission === undefined
                ? {}
                : { askPermission: options.askPermission }),
            ...(options.wake === undefined ? {} : { wake: options.wake }),
        }),
        profile: options.profile ?? {
            modelOptions: (model) =>
                model === undefined ? [] : [{ configId: "model", value: model }],
            permissionOptions: (mode) => [{ configId: "mode", value: mode }],
        },
    });
    const messages: SessionMessage[] = [];
    return {
        messages,
        directory,
        stateDirectory: join(directory, "state"),
        launch,
        setPermissionMode: (mode: AcpPermissionMode) => {
            permissionMode = mode;
        },
        log: (): Record<string, unknown>[] =>
            readFileSync(logPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>),
        async waitForLog(predicate: (entry: Record<string, unknown>) => boolean): Promise<void> {
            for (let i = 0; i < 200; i++) {
                try {
                    if (
                        readFileSync(logPath, "utf8")
                            .trim()
                            .split("\n")
                            .map((line) => JSON.parse(line) as Record<string, unknown>)
                            .some(predicate)
                    ) {
                        return;
                    }
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("Timed out waiting for expected log entry.");
        },
        async session(): Promise<AcpSession> {
            const session = await provider.session("agent-1", {
                instructions: "Be Happy.",
                tools: options.tools ?? tools,
            });
            open.push(session);
            return session;
        },
        user(text: string): void {
            messages.push({ role: "user", content: [{ type: "text", text }] });
        },
        /** Consume one response exactly as Agent Base does: stop reading at `done`. */
        async run(
            session: AcpSession,
            signal?: AbortSignal,
            steered?: AbortSignal,
            onEvent?: (event: SessionEvent) => void,
        ): Promise<SessionEvent[]> {
            const events: SessionEvent[] = [];
            const accumulator = new SessionAssistantMessageAccumulator();
            const ctx = withLifetime(
                createRootContext().named("acp-test"),
                signal ?? new AbortController().signal,
            );
            for await (const event of session.run(ctx, {
                context: { instructions: "Be Happy.", messages },
                model: "m1",
                ...(steered === undefined ? {} : { steered }),
            })) {
                events.push(event);
                accumulator.add(event);
                onEvent?.(event);
                if (event.type === "done") break;
            }
            const message = accumulator.message();
            if (message !== undefined) messages.push(message);
            return events;
        },
    };
}

const text = (events: readonly SessionEvent[]) =>
    events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");
const done = (events: readonly SessionEvent[]) => events.find((event) => event.type === "done");

describe("AcpSession", () => {
    it("reports the agent's own tools as settled provider calls", async () => {
        const h = harness();
        const session = await h.session();
        h.user("hello");
        const events = await h.run(session);
        const start = events.find((event) => event.type === "toolcall_start");
        expect(start).toMatchObject({ name: "read", server: true });
        expect(events.some((event) => event.type === "toolcall_result_end")).toBe(true);
        expect(done(events)).toMatchObject({ state: "normal", endTurn: true });
        expect(h.messages.at(-1)).toMatchObject({ role: "assistant" });
    }, 30_000);

    it("ends the response with a bridged Happy tool call and resumes the same prompt with its result", async () => {
        const h = harness();
        const session = await h.session();
        h.user("please use happy");
        const first = await h.run(session);
        expect(done(first)).toMatchObject({ state: "tool_call" });
        const call = first.find(
            (event): event is Extract<SessionEvent, { type: "toolcall_start" }> =>
                event.type === "toolcall_start" && event.server !== true,
        );
        expect(call).toMatchObject({ name: "happy_secret" });
        expect(
            first.find((event) => event.type === "toolcall_end" && event.callId === call!.callId),
        ).toMatchObject({ arguments: JSON.stringify({ why: "test" }) });

        h.messages.push({
            role: "tool",
            callId: call!.callId,
            content: [{ type: "text", text: "pomegranate" }],
        });
        const second = await h.run(session);
        expect(text(second)).toBe("secret=pomegranate");
        expect(done(second)).toMatchObject({ state: "normal" });
        // One foreign prompt served both Happy responses.
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);
        // The agent sees the schema without its JavaScript-dialect pattern, which agents that
        // validate schemas in another regex dialect would reject.
        expect(h.log().find((entry) => entry.method === "mcp.listTools")).toMatchObject({
            names: ["happy_secret"],
            schemas: [
                {
                    type: "object",
                    properties: { why: { type: "string" } },
                },
            ],
        });
        const listed = h.log().find((entry) => entry.method === "mcp.listTools") as {
            schemas: { properties: { why: Record<string, unknown> } }[];
        };
        expect(listed.schemas[0]!.properties.why).not.toHaveProperty("pattern");
    }, 30_000);

    it("sends a fresh session Happy's instructions, then only new input on later turns", async () => {
        const h = harness();
        const session = await h.session();
        h.user("first");
        await h.run(session);
        h.user("second");
        await h.run(session);
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts[0]!.text).toContain("<happy-instructions>\nBe Happy.");
        expect(prompts[1]!.text).toBe("second");
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("continues the stored foreign session from a new process without replaying its history", async () => {
        const h = harness();
        const first = await h.session();
        h.user("first");
        await h.run(first);
        await first.destroy();

        const second = await h.session();
        h.user("after restart");
        const events = await h.run(second);
        expect(text(events)).toBe("echo:after restart");
        expect(text(events)).not.toContain("REPLAYED-HISTORY");
        expect(h.log().filter((entry) => entry.method === "loadSession")).toHaveLength(1);
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("replays Happy's transcript into a new session when the history no longer matches", async () => {
        const h = harness();
        const session = await h.session();
        h.user("original question");
        await h.run(session);
        // A compaction or an edit replaces what the foreign session saw.
        h.messages.splice(0, h.messages.length);
        h.user("summary of earlier work");
        h.messages.push({ role: "assistant", content: [{ type: "text", text: "noted" }] });
        h.user("continue");
        const events = await h.run(session);
        expect(text(events)).toContain("<conversation-so-far>");
        expect(text(events)).toContain("User: summary of earlier work");
        expect(text(events)).toContain("Assistant: noted");
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(2);
    }, 30_000);

    it("sends a prompt the agent's service refused as too many requests again, a little later", async () => {
        const h = harness();
        const session = await h.session();
        h.user("throttled hello");
        const events = await h.run(session);
        expect(events.find((event) => event.type === "retrying")).toMatchObject({ attempt: 1 });
        expect(text(events).endsWith("throttled hello")).toBe(true);
        expect(done(events)).toMatchObject({ state: "normal" });
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.text).toBe(prompts[0]!.text);
    }, 30_000);

    it("does not send a refused prompt again once the agent reported acting on it", async () => {
        const h = harness();
        const session = await h.session();
        h.user("throttled late");
        const events = await h.run(session);
        expect(events.some((event) => event.type === "retrying")).toBe(false);
        expect(done(events)).toMatchObject({ state: "error" });
        expect(String((done(events) as { message?: string }).message)).toContain("429");
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);
    }, 30_000);

    it("stops waiting to send a refused prompt again when the response is stopped", async () => {
        const h = harness();
        const session = await h.session();
        h.user("throttled hello");
        const stop = new AbortController();
        // Stop once the wait has begun, however long the agent took to refuse.
        let waiting = 0;
        const events = await h.run(session, stop.signal, undefined, (event) => {
            if (event.type !== "retrying") return;
            waiting = Date.now();
            stop.abort();
        });
        expect(done(events)).toMatchObject({ state: "cancelled" });
        // The first retry waits seconds; stopping ends it at once.
        expect(Date.now() - waiting).toBeLessThan(1_500);
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);
    }, 30_000);

    it("ends the wait to resend a refused prompt on steering, sending that prompt once with the steering", async () => {
        const h = harness();
        const session = await h.session();
        h.user("throttled first");
        const steer = new AbortController();
        // Steer once the wait has begun, however long the agent took to refuse.
        let waiting = 0;
        const first = await h.run(session, undefined, steer.signal, (event) => {
            if (event.type !== "retrying") return;
            waiting = Date.now();
            steer.abort();
        });
        // The first retry waits seconds; steering ends it at once.
        expect(Date.now() - waiting).toBeLessThan(1_500);
        expect(done(first)).toMatchObject({ state: "normal" });
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);

        h.user("steered instead");
        const second = await h.run(session);
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        // The old prompt is not resent on its own; it goes once, joined by the steering.
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.text).toContain("throttled first");
        expect(prompts[1]!.text).toContain("steered instead");
        expect(done(second)).toMatchObject({ state: "normal" });
    }, 30_000);

    it("does not retry a 429 that names a quota resetting in hours", async () => {
        const h = harness();
        const session = await h.session();
        h.user("over quota");
        const events = await h.run(session);
        expect(events.some((event) => event.type === "retrying")).toBe(false);
        expect(String((done(events) as { message?: string }).message)).toContain("weekly limit");
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);
    }, 30_000);

    it("catches a session up on turns another account or harness answered, keeping the session", async () => {
        const h = harness();
        const session = await h.session();
        h.user("first");
        await h.run(session);
        // The conversation switched elsewhere for a turn, then came back.
        h.user("second");
        h.messages.push({ role: "assistant", content: [{ type: "text", text: "from elsewhere" }] });
        h.user("third");
        await h.run(session);
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts[1]!.text).toContain("<conversation-elsewhere>");
        expect(prompts[1]!.text).toContain("User: second");
        expect(prompts[1]!.text).toContain("Assistant: from elsewhere");
        expect(prompts[1]!.text).not.toContain("echo:first");
        expect(String(prompts[1]!.text).endsWith("third")).toBe(true);
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("maps the model and permission mode onto config options, setting each only when it changes", async () => {
        const h = harness();
        const session = await h.session();
        h.user("one");
        await h.run(session);
        h.user("two");
        await h.run(session);
        h.setPermissionMode("read_only");
        h.user("three");
        await h.run(session);
        const options = h
            .log()
            .filter((entry) => entry.method === "setSessionConfigOption")
            .map((entry) => `${String(entry.configId)}=${String(entry.value)}`);
        expect(options).toEqual(["model=m1", "mode=auto", "mode=read_only"]);
    }, 30_000);

    it("interrupts the foreign turn on steering and sends only the steering next", async () => {
        const h = harness();
        const session = await h.session();
        h.user("wait for me");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        steering.abort();
        // A normal end keeps Agent Base's loop going, so it injects the steering and asks again.
        expect(done(await running)).toMatchObject({ state: "normal" });

        h.user("change of plan");
        expect(text(await h.run(session))).toBe("echo:change of plan");
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts.at(-1)).toMatchObject({ text: "change of plan" });
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("replays the opening into a new session when steering stops a first prompt the agent never ended", async () => {
        const h = harness();
        const session = await h.session();
        h.user("stubborn opening task");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await h.waitForLog((e) => e.method === "prompt" && String(e.text).includes("stubborn"));
        steering.abort();
        expect(done(await running)).toMatchObject({ state: "normal" });

        // The stopped agent never saved the session it bound, so restoring it would continue an
        // empty conversation with only the steering. The opening must reach the agent again.
        h.user("follow-up facts");
        const reply = text(await h.run(session));
        expect(reply).toContain("<happy-instructions>\nBe Happy.");
        expect(reply).toContain("User: stubborn opening task");
        expect(reply).toContain("follow-up facts");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(2);
        expect(log.filter((entry) => entry.method === "loadSession")).toHaveLength(0);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
    }, 30_000);

    it("replays the opening after a daemon reload when the previous process was stopped unanswered", async () => {
        const h = harness();
        const session = await h.session();
        h.user("stubborn opening task");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await h.waitForLog((e) => e.method === "prompt" && String(e.text).includes("stubborn"));
        steering.abort();
        expect(done(await running)).toMatchObject({ state: "normal" });

        // Simulate a daemon restart: destroy current session and create a fresh provider and session
        // against the exact same stateDirectory and command.
        await session.destroy();
        const reloadedProvider = new AcpProvider({
            launch: h.launch,
            stateDirectory: h.stateDirectory,
            environment: () => ({ cwd: h.directory, permissionMode: "auto" }),
            profile: {
                modelOptions: (model) =>
                    model === undefined ? [] : [{ configId: "model", value: model }],
                permissionOptions: (mode) => [{ configId: "mode", value: mode }],
            },
        });
        const reloadedSession = await reloadedProvider.session("agent-1", {
            instructions: "Be Happy.",
            tools,
        });
        open.push(reloadedSession);

        h.user("follow-up after reload");
        const reply = text(await h.run(reloadedSession));
        expect(reply).toContain("<happy-instructions>\nBe Happy.");
        expect(reply).toContain("User: stubborn opening task");
        expect(reply).toContain("follow-up after reload");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(2);
        expect(log.filter((entry) => entry.method === "loadSession")).toHaveLength(0);
    }, 30_000);

    // Characterizes existing base behavior: a first prompt that rejects with prompt_error before settling never writes a session record.
    it("does not write a resume record to disk when a first prompt ends in prompt_error and replays on retry", async () => {
        const h = harness();
        const session = await h.session();
        h.user("fail late prompt");
        const events = await h.run(session);
        expect(done(events)).toMatchObject({
            state: "error",
            message: expect.stringContaining("internal agent error after update"),
        });

        // Verify that no unconfirmed session record was persisted to disk.
        await expect(acpSessionRecordRead(h.stateDirectory, "agent-1")).resolves.toBeUndefined();

        h.user("recovery attempt");
        const reply = text(await h.run(session));
        expect(reply).toContain("<happy-instructions>\nBe Happy.");
        expect(reply).toContain("fail late prompt");
        expect(reply).toContain("recovery attempt");
    }, 30_000);

    it("replays the opening when user abort cancels a first prompt before the agent ends it", async () => {
        const h = harness();
        const session = await h.session();
        h.user("stubborn opening task");
        const abortController = new AbortController();
        const running = h.run(session, abortController.signal);
        await h.waitForLog((e) => e.method === "prompt" && String(e.text).includes("stubborn"));
        abortController.abort();
        const result = await running;
        expect(done(result)).toMatchObject({ state: "cancelled" });

        // Assert nothing is on disk
        await expect(acpSessionRecordRead(h.stateDirectory, "agent-1")).resolves.toBeUndefined();

        h.user("follow-up after cancel");
        const reply = text(await h.run(session));
        expect(reply).toContain("<happy-instructions>\nBe Happy.");
        expect(reply).toContain("User: stubborn opening task");
        expect(reply).toContain("follow-up after cancel");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(2);
        expect(log.filter((entry) => entry.method === "loadSession")).toHaveLength(0);
    }, 30_000);

    it("keeps continuing a session that already answered when a later prompt is stopped unanswered", async () => {
        const h = harness();
        const session = await h.session();
        h.user("first");
        await h.run(session);
        h.user("stubborn second");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await h.waitForLog(
            (e) => e.method === "prompt" && String(e.text).includes("stubborn second"),
        );
        steering.abort();
        await running;

        h.user("third");
        expect(text(await h.run(session))).toBe("echo:third");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "loadSession")).toHaveLength(1);
    }, 30_000);

    it("shows a turn the agent started on its own in the run its wake notice starts", async () => {
        const notices: SessionSystemMessage[] = [];
        const h = harness({ wake: (notice) => notices.push(notice) });
        const session = await h.session();
        h.user("start in the background");
        expect(text(await h.run(session)).endsWith("start in the background")).toBe(true);
        await vi.waitFor(() => expect(notices).toHaveLength(1));

        h.messages.push(notices[0]!);
        const woken = await h.run(session);
        expect(text(woken)).toBe("background:done");
        expect(done(woken)).toMatchObject({ state: "normal", endTurn: true });
        expect(woken.find((event) => event.type === "token_usage")).toMatchObject({
            usage: { output: 4 },
        });
        // The notice only starts the run; the agent is never sent it.
        h.user("next");
        await h.run(session);
        expect(
            h
                .log()
                .filter((entry) => entry.method === "prompt")
                .map((entry) => entry.text),
        ).toEqual([expect.stringContaining("start in the background"), "next"]);
    }, 30_000);

    it("hands a message sent before the wake run to the agent after its own turn", async () => {
        const notices: SessionSystemMessage[] = [];
        const h = harness({ steerable: true, wake: (notice) => notices.push(notice) });
        const session = await h.session();
        h.user("start in the background");
        await h.run(session);
        await vi.waitFor(() => expect(notices).toHaveLength(1));

        h.user("and then this");
        h.messages.push(notices[0]!);
        const woken = await h.run(session);
        expect(text(woken)).toBe("background:doneecho:and then this");
        expect(done(woken)).toMatchObject({ state: "normal", endTurn: true });
        expect(
            h
                .log()
                .filter((entry) => entry.method === "prompt")
                .at(-1),
        ).toMatchObject({
            text: "and then this",
        });
    }, 30_000);

    it("ends a wake run empty when its turn did not survive a restart, without prompting", async () => {
        const notices: SessionSystemMessage[] = [];
        const h = harness({ wake: (notice) => notices.push(notice) });
        const first = await h.session();
        h.user("start in the background");
        await h.run(first);
        await vi.waitFor(() => expect(notices).toHaveLength(1));
        await first.destroy();

        // The notice is durable; the turn it was sent for lived only in the stopped daemon.
        const second = await h.session();
        h.messages.push(notices[0]!);
        const events = await h.run(second);
        expect(text(events)).toBe("");
        expect(done(events)).toMatchObject({ state: "normal" });
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);
    }, 30_000);

    it("hands steering to an agent that takes input mid-turn without stopping it", async () => {
        const h = harness({ steerable: true });
        const session = await h.session();
        h.user("wait for me");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        steering.abort();
        expect(done(await running)).toMatchObject({ state: "normal" });

        h.user("change of plan");
        expect(text(await h.run(session))).toBe("steered:change of plan");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "cancel")).toHaveLength(0);
        expect(log.filter((entry) => entry.method === "prompt")).toHaveLength(1);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    }, 30_000);

    it("stops the agent process when the consumer stops reading, as Agent Base does on abort", async () => {
        const h = harness();
        const session = await h.session();
        h.user("wait for me");
        const stream = session
            .run(createRootContext().named("acp-test"), {
                context: { instructions: "Be Happy.", messages: h.messages },
                model: "m1",
            })
            [Symbol.asyncIterator]();
        await stream.next();
        const pending = stream.next();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        void pending.catch(() => undefined);
        await stream.return?.(undefined);

        h.user("next");
        expect(text(await h.run(session))).toBe("echo:next");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "cancel")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(1);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
        expect(log.filter((entry) => entry.method === "prompt").at(-1)).toMatchObject({
            text: "next",
        });
    }, 30_000);

    it("stops the agent process on abort and continues the same session from a new one", async () => {
        const h = harness();
        const session = await h.session();
        h.user("wait for me");
        const controller = new AbortController();
        const running = h.run(session, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        controller.abort();
        expect(done(await running)).toMatchObject({ state: "cancelled" });

        // The stopped request is not repeated: the new process restores the session and is sent
        // only what arrived after the stop.
        h.user("next");
        expect(text(await h.run(session))).toBe("echo:next");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "cancel")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "loadSession")).toHaveLength(1);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
        expect(log.filter((entry) => entry.method === "prompt").at(-1)).toMatchObject({
            text: "next",
        });
    }, 30_000);

    it("answers the agent's own permission asks by mode and puts the rest to the person", async () => {
        const questions: AcpPermissionQuestion[] = [];
        let answer: "allow_for_session" | "deny" = "allow_for_session";
        const h = harness({
            askPermission: async (question) => {
                questions.push(question);
                return answer;
            },
        });
        const session = await h.session();

        // Read only refuses and Full access allows, without asking anyone.
        h.setPermissionMode("read_only");
        h.user("needs permission");
        expect(text(await h.run(session))).toBe("permission=no");
        h.setPermissionMode("full_access");
        h.user("needs permission");
        expect(text(await h.run(session))).toBe("permission=yes");
        h.user("needs permission only always");
        expect(text(await h.run(session))).toBe("permission=always");
        expect(questions).toEqual([]);

        // Otherwise the person decides, offered the session-wide allow the agent offers.
        h.setPermissionMode("workspace_write");
        h.user("needs permission");
        expect(text(await h.run(session))).toBe("permission=always");
        answer = "deny";
        h.setPermissionMode("auto");
        h.user("needs permission");
        expect(text(await h.run(session))).toBe("permission=no");
        expect(questions).toEqual([
            { action: 'rm -rf build\n{"command":"rm -rf build"}', allowForSession: true },
            { action: 'rm -rf build\n{"command":"rm -rf build"}', allowForSession: true },
        ]);
    }, 30_000);

    it("lets a Happy tool call through in Workspace write when the tool's own rule needs no approval", async () => {
        const asked: string[] = [];
        let review = false;
        const h = harness({
            tools: [
                {
                    ...tools[0]!,
                    shouldReviewInAutoMode: (args: { why?: string }) =>
                        review || args.why !== "test",
                },
                { name: "happy_listed", description: "Never reviewed.", autoReview: "never" },
                { name: "listed", namespace: "ns", autoReview: "never" },
            ],
            askPermission: async (question) => {
                asked.push(question.action);
                return "deny";
            },
        });
        const session = await h.session();
        h.setPermissionMode("workspace_write");
        h.user("needs permission for happy");
        expect(text(await h.run(session))).toBe("permission=yes");
        expect(asked).toEqual([]);

        // A call its rule says needs approval goes to the person, as does any call in Auto.
        review = true;
        h.user("needs permission for happy");
        expect(text(await h.run(session))).toBe("permission=no");
        review = false;
        h.setPermissionMode("auto");
        h.user("needs permission for happy");
        expect(text(await h.run(session))).toBe("permission=no");
        expect(asked).toHaveLength(2);

        // The agent is told which bridged tools it may call without asking at all.
        expect(h.log().find((entry) => entry.method === "newSession")).toMatchObject({
            approvedTools: ["happy_listed", "ns__listed"],
        });
    }, 30_000);

    it("withdraws the person's question and cancels the agent's ask when the turn stops", async () => {
        let withdrawn: AbortSignal | undefined;
        const h = harness({
            askPermission: (_question, signal) => {
                withdrawn = signal;
                return new Promise((resolve) =>
                    signal.addEventListener("abort", () => resolve("deny"), { once: true }),
                );
            },
        });
        const session = await h.session();
        h.setPermissionMode("workspace_write");
        h.user("needs permission");
        const stop = new AbortController();
        const running = h.run(session, stop.signal);
        for (let i = 0; i < 200 && withdrawn === undefined; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(withdrawn?.aborted).toBe(false);
        stop.abort();
        expect(done(await running)).toMatchObject({ state: "cancelled" });
        expect(withdrawn?.aborted).toBe(true);
        // Whatever the person's side answers once withdrawn, the agent is told the ask was cancelled.
        await h.waitForLog((entry) => entry.method === "permission");
        expect(h.log().find((entry) => entry.method === "permission")).toMatchObject({
            chosen: "cancelled",
        });
    }, 30_000);

    it("reads the models an agent serves from its model selector", async () => {
        const directory = mkdtempSync(join(tmpdir(), "acp-discover-"));
        const values = await acpDiscoverModels(
            {
                command: process.execPath,
                args: [AGENT],
                env: { SCRIPTED_ACP_LOG: join(directory, "agent.jsonl") },
            },
            directory,
        );
        expect(values).toEqual([
            { value: "m1", name: "Model One" },
            { value: "m2-high", name: "Model Two (High)" },
        ]);
        expect(
            antigravityAgent.modelsFromSelector([
                { value: "gemini-9", name: "Gemini 9" },
                { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
                { value: "oss-1-medium", name: "OSS One (Medium)" },
            ]),
        ).toEqual([
            // A plain name takes agy's thinking levels as its efforts.
            expect.objectContaining({
                id: "antigravity/gemini-9",
                name: "Gemini 9",
                effortLevels: ["low", "medium", "high"],
                defaultEffort: "medium",
            }),
            expect.objectContaining({
                id: "antigravity/gemini-3.8-flash",
                effortLevels: ["low", "medium", "high"],
                defaultEffort: "high",
            }),
            // A model served at one effort only carries it in its name.
            expect.objectContaining({
                id: "antigravity/oss-1",
                name: "OSS One",
                effortLevels: ["medium"],
            }),
        ]);
    }, 30_000);

    it("assumes Gemini 4 Carbon first, with Antigravity's three efforts", () => {
        expect(antigravityAgent.models[0]).toMatchObject({
            id: "antigravity/gemini-4-carbon",
            name: "Gemini 4 Carbon",
            effortLevels: ["low", "medium", "high"],
            defaultEffort: "medium",
        });
        // agy offers whichever spelling it serves the model under; the effort is its own option.
        expect(
            antigravityAgent.profile.modelOptions?.("antigravity/gemini-4-carbon", undefined),
        ).toEqual([
            { configId: "model", value: "gemini-4-carbon" },
            { configId: "model", value: "gemini-4-carbon-medium" },
            { configId: "thought_level", value: "medium" },
        ]);
        expect(antigravityAgent.profile.permissionOptions?.("workspace_write")).toEqual([
            { configId: "mode", value: "accept-edits" },
        ]);
    });

    it("drives any ACP agent from its command, offering and selecting the models it reports", async () => {
        const directory = mkdtempSync(join(tmpdir(), "acp-generic-"));
        const logPath = join(directory, "agent.jsonl");
        const agent = acpGenericAgent("scripted");
        const connect = agent.connect({
            command: process.execPath,
            args: [AGENT],
            env: { SCRIPTED_ACP_LOG: logPath },
        });
        const models = agent.modelsFromSelector(await acpDiscoverModels(connect, directory));
        expect(models.map((model) => model.id)).toEqual([
            "acp/scripted/m1",
            "acp/scripted/m2-high",
        ]);

        const provider = new AcpProvider({
            connect,
            stateDirectory: join(directory, "state"),
            environment: () => ({ cwd: directory, permissionMode: "auto" }),
            profile: agent.profile,
        });
        const session = await provider.session("agent-1", { instructions: "", tools: [] });
        open.push(session);
        const ctx = withLifetime(
            createRootContext().named("acp-test"),
            new AbortController().signal,
        );
        for await (const event of session.run(ctx, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            },
            model: "acp/scripted/m2-high",
        })) {
            if (event.type === "done") break;
        }
        const options = readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((entry) => entry.method === "setSessionConfigOption");
        expect(options).toEqual([expect.objectContaining({ configId: "model", value: "m2-high" })]);
    }, 30_000);

    it("sets an option wanted by category on whatever the agent calls it", () => {
        const advertised = [
            {
                id: "llm",
                name: "LLM",
                category: "model",
                type: "select",
                currentValue: "a",
                options: [{ value: "a", name: "A" }],
            },
        ] as acp.SessionConfigOption[];
        expect(
            acpConfigOptionId(advertised, { configId: "model", category: "model", value: "a" }),
        ).toBe("llm");
        expect(
            acpConfigOptionId([], { configId: "model", category: "model", value: "a" }),
        ).toBeUndefined();
        expect(acpConfigOptionId([], { configId: "mode", value: "plan" })).toBe("mode");
    });

    it.skipIf(process.getuid?.() === 0)(
        "invalidates the session record with a tombstone or throws when acpSessionRecordClear cannot unlink",
        async () => {
            const directory = mkdtempSync(join(tmpdir(), "acp-clear-"));
            const sessionsDir = join(directory, "sessions");
            await acpSessionRecordWrite(directory, "agent-1", {
                acpSessionId: "s-old",
                cwd: directory,
                consumed: 1,
                fingerprint: "fp1",
            });
            expect(await acpSessionRecordRead(directory, "agent-1")).toMatchObject({
                acpSessionId: "s-old",
            });

            const warnSpy = vi.fn();
            const noop = () => undefined;
            const ctx = withLogger(createRootContext().named("acp-clear-test"), {
                trace: noop,
                debug: noop,
                info: noop,
                warn: warnSpy,
                error: noop,
                fatal: noop,
            });

            // Removing write permission on the parent directory makes rm() fail with EACCES while the
            // writable file itself can still be overwritten with a "{}" tombstone.
            chmodSync(sessionsDir, 0o500);
            try {
                await acpSessionRecordClear(directory, "agent-1", ctx);
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(await acpSessionRecordRead(directory, "agent-1")).toBeUndefined();
            } finally {
                chmodSync(sessionsDir, 0o700);
            }

            // When both rm() and the tombstone write fail (e.g. target path is a directory), it throws.
            mkdirSync(join(sessionsDir, "dir-collision.json"));
            await expect(acpSessionRecordClear(directory, "dir-collision", ctx)).rejects.toThrow(
                /Failed to clear or invalidate ACP session record for dir-collision/,
            );
        },
    );
});
