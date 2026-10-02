import { createRootContext } from "@steve.kite/stdlib";
import type { BaseProvider, SessionEvent, SessionOptions } from "@slopus/happy-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    LIVE_CONTROLLER_TOOLS,
    runLiveController,
} from "../sources/live/impl/runLiveController.js";
import type { LiveDesktopActionResult, LiveDesktopContext } from "@slopus/happy-agent-client";

const context: LiveDesktopContext = {
    windowId: "window",
    connections: [],
    activeConnectionId: null,
    activeTarget: null,
    projects: [],
    workspaces: [],
    sessions: [],
    bots: [],
    activeSession: null,
    truncated: false,
};
const ctx = createRootContext().named("live-controller-test");
afterEach(() => vi.useRealTimers());

function fixture(rounds: SessionEvent[][]) {
    let round = 0;
    let options: SessionOptions | undefined;
    const requests: unknown[] = [];
    const destroy = vi.fn(async () => undefined);
    const provider = {
        session: async (_id: string, selected: SessionOptions) => {
            options = selected;
            return {
                destroy,
                run: async function* (_ctx: unknown, request: unknown) {
                    requests.push(structuredClone(request));
                    for (const event of rounds[round++] ?? []) yield event;
                },
            };
        },
    } as unknown as BaseProvider;
    const execute = vi.fn(
        async (): Promise<LiveDesktopActionResult> => ({
            status: "succeeded",
            output: { type: "staged" },
        }),
    );
    const run = () =>
        runLiveController(ctx, {
            provider,
            model: "fixed-model",
            effort: "high",
            context,
            fragments: [{ transcriptId: "fragment", role: "user", text: "send hello" }],
            signal: new AbortController().signal,
            execute,
        });
    return { run, execute, destroy, requests, options: () => options };
}
const done: SessionEvent = { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } };

describe("bounded Live side inference", () => {
    it("releases the deadline when provider session creation fails", async () => {
        vi.useFakeTimers();
        const provider = {
            session: async () => {
                throw new Error("factory failed");
            },
        } as unknown as BaseProvider;
        await expect(
            runLiveController(ctx, {
                provider,
                model: "fixture",
                effort: "low",
                context,
                fragments: [],
                signal: new AbortController().signal,
                execute: vi.fn(),
            }),
        ).rejects.toThrow("factory failed");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds a hanging factory and destroys its late session without inference", async () => {
        vi.useFakeTimers();
        let resolve!: (session: unknown) => void;
        const destroy = vi.fn(async () => undefined);
        const run = vi.fn();
        const provider = {
            session: () =>
                new Promise((yes) => {
                    resolve = yes;
                }),
        } as unknown as BaseProvider;
        let ended = false;
        const pending = runLiveController(ctx, {
            provider,
            model: "fixture",
            effort: "low",
            context,
            fragments: [],
            signal: new AbortController().signal,
            execute: vi.fn(),
        }).catch(() => {
            ended = true;
        });
        await vi.advanceTimersByTimeAsync(120_001);
        try {
            expect(ended).toBe(true);
        } finally {
            resolve({ destroy, run });
            await pending;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(run).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects oversized initial context before opening provider inference", async () => {
        const session = vi.fn();
        const provider = { session } as unknown as BaseProvider;
        await expect(
            runLiveController(ctx, {
                provider,
                model: "fixture",
                effort: "low",
                context,
                fragments: [],
                delegationText: "x".repeat(512 * 1024),
                signal: new AbortController().signal,
                execute: vi.fn(),
            }),
        ).rejects.toThrow("context limit");
        expect(session).not.toHaveBeenCalled();
    });
    it("exposes exactly nine desktop tools and preserves staged results as data", async () => {
        const f = fixture([
            [
                { type: "toolcall_start", callId: "c1", name: "sessionSend" },
                {
                    type: "toolcall_end",
                    callId: "c1",
                    arguments: JSON.stringify({
                        target: { connectionId: "conn", groupId: "group", sessionId: "session" },
                        text: "hello",
                    }),
                },
                done,
            ],
            [
                { type: "text_delta", delta: "Staged; review it and press Send." },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        await expect(f.run()).resolves.toContain("Staged");
        expect(LIVE_CONTROLLER_TOOLS.map((tool) => tool.name)).toEqual([
            "desktopState",
            "desktopOpen",
            "workspaceCreate",
            "sessionCreate",
            "botCreate",
            "sessionRead",
            "sessionSend",
            "sessionWatch",
            "composerDraftAppend",
        ]);
        expect(f.options()).toMatchObject({ inferenceMaxRetries: 0, tools: LIVE_CONTROLLER_TOOLS });
        expect(f.execute).toHaveBeenCalledOnce();
        expect(JSON.stringify(f.requests[1])).toContain("staged");
        expect(f.destroy).toHaveBeenCalledOnce();
    });

    it.each(["exec_command", "request_user_input", "set_admin", "send_agent_message"])(
        "never executes an unlisted %s tool",
        async (name) => {
            const f = fixture([
                [
                    { type: "toolcall_start", callId: "c1", name },
                    { type: "toolcall_end", callId: "c1", arguments: "{}" },
                    done,
                ],
            ]);
            await expect(f.run()).rejects.toThrow("invalid");
            expect(f.execute).not.toHaveBeenCalled();
            expect(f.destroy).toHaveBeenCalledOnce();
        },
    );

    it("rejects multiple simultaneous actions before executing any mutation", async () => {
        const f = fixture([
            [
                { type: "toolcall_start", callId: "a", name: "desktopState" },
                { type: "toolcall_end", callId: "a", arguments: "{}" },
                { type: "toolcall_start", callId: "b", name: "workspaceCreate" },
                done,
            ],
        ]);
        await expect(f.run()).rejects.toThrow("unsupported");
        expect(f.execute).not.toHaveBeenCalled();
    });
});
