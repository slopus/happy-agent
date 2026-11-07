import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAgentGym, type GymInferenceRequest, type GymTurn } from "@slopus/happy-agent-gym";
import type { SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { expect, it } from "vitest";

/**
 * Golden fixtures for what Agent Base keeps of a response that did not complete normally. Each
 * case streams one scripted provider response into the real daemon and its unmodified Agent Base,
 * then records the context of the next request the agent makes: that context is exactly what Base
 * persisted, with provider tool IDs, plus the results it settled for calls nobody dispatched.
 * `HAPPY_AGENT_SURFACE_UPDATE=1` rewrites the fixtures; otherwise they are compared.
 */
const FIXTURES = resolve(import.meta.dirname, "../fixtures/failed-response-checkpoints");
const UPDATE = process.env.HAPPY_AGENT_SURFACE_UPDATE === "1";

const MODEL = {
    providerId: "claude",
    id: "anthropic/opus-5-5",
    name: "Opus 5.5",
    effortLevels: ["medium"] as const,
    defaultEffort: "medium" as const,
};
const TOKENS = { input: 1, output: 1 };
const READ_ARGUMENTS = '{"file_path":"README.md"}';
const SEARCH_ARGUMENTS = '{"query":"select:Read"}';

/** The tool policies these cases touch, as Agent Base reads them from the agent's tool array. */
const POLICIES = {
    Read: { server: false, persistInHistory: true, visibleToUser: true },
    // Claude Code's own tool search, which Base must keep out of history and out of view.
    ToolSearch: { server: true, persistInHistory: false, visibleToUser: false },
};

interface Case {
    readonly name: string;
    readonly description: string;
    readonly turn: GymTurn;
    /** How the response ends, as Base sees it. */
    readonly stop: "error" | "normal" | "cancelled" | "eof";
    readonly abortAfterText?: string;
}

const text = (value: string): SessionEvent[] => [
    { type: "text_start" },
    { type: "text_delta", delta: value },
    { type: "text_end" },
];
const readCall = (callId: string, finished: boolean): SessionEvent[] => [
    { type: "toolcall_start", callId, name: "Read" },
    { type: "toolcall_delta", callId, delta: READ_ARGUMENTS },
    ...(finished
        ? [{ type: "toolcall_end", callId, arguments: READ_ARGUMENTS } as SessionEvent]
        : []),
];
const searchCall = (callId: string): SessionEvent[] => [
    { type: "toolcall_start", callId, name: "ToolSearch", server: true },
    { type: "toolcall_delta", callId, delta: SEARCH_ARGUMENTS },
    { type: "toolcall_end", callId, arguments: SEARCH_ARGUMENTS },
];
const failure: SessionEvent = {
    type: "done",
    state: "error",
    kind: "internal_error",
    message: "The provider connection failed.",
};

const CASES: readonly Case[] = [
    {
        name: "text_partial_then_error",
        description: "A text block that never ends, then a provider error.",
        turn: {
            events: [{ type: "text_start" }, { type: "text_delta", delta: "Half a sen" }, failure],
        },
        stop: "error",
    },
    {
        name: "finished_call_then_error",
        description: "Finished text and a finished client tool call, then a provider error.",
        turn: { events: [...text("Reading it."), ...readCall("toolu_read_error", true), failure] },
        stop: "error",
    },
    {
        name: "server_call_without_result_then_text",
        description: "A provider-run call that exposes no result, then text, ending normally.",
        turn: {
            events: [
                ...searchCall("toolu_search_alone"),
                ...text("Found it."),
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "server_call_with_result",
        description: "A provider-run call with its result, then text, ending normally.",
        turn: {
            events: [
                ...searchCall("toolu_search_paired"),
                { type: "toolcall_result_start", callId: "toolu_search_paired" },
                {
                    type: "toolcall_result_end",
                    callId: "toolu_search_paired",
                    content: [{ type: "text", text: "Read is loaded." }],
                },
                ...text("Found it."),
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "block_reset_mid_call",
        description: "A call reset mid-stream by the provider, replaced by text, ending normally.",
        turn: {
            events: [
                ...text("Let me look."),
                { type: "block_start" },
                ...readCall("toolu_reset", false),
                { type: "block_reset" },
                { type: "block_start" },
                ...text("Never mind."),
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "finished_text_reset_then_retry",
        description: "A finished text block reset by the provider, retried, ending normally.",
        turn: {
            events: [
                { type: "block_start" },
                ...text("First try."),
                { type: "block_reset" },
                { type: "block_start" },
                ...text("Second try."),
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "abort_mid_text_after_reasoning",
        description: "Finished reasoning, then text cut off by an abort.",
        turn: {
            content: [
                { type: "reasoning", text: "Thinking it through." },
                { type: "text", text: "Partial answer that keeps going and going." },
            ],
            textDeltaChunkSize: 4,
            textDeltaDelayMs: 400,
        },
        stop: "cancelled",
        // The third four-character delta, so the abort lands mid-text.
        abortAfterText: "answ",
    },
    {
        name: "stream_end_without_done",
        description: "Finished text and an unfinished call, then the stream ends without done.",
        turn: { events: [...text("Reading it."), ...readCall("toolu_read_eof", false)] },
        stop: "eof",
    },
];

/** Replaces values that differ between runs; provider tool IDs are fixed and kept. */
function normalize(messages: readonly SessionMessage[], agentId: string): unknown {
    return JSON.parse(JSON.stringify(messages).replaceAll(agentId, "{{agentId}}"));
}

function stableJson(value: unknown): string {
    const sort = (item: unknown): unknown =>
        Array.isArray(item)
            ? item.map(sort)
            : item !== null && typeof item === "object"
              ? Object.fromEntries(
                    Object.keys(item)
                        .sort()
                        .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
                )
              : item;
    return `${JSON.stringify(sort(value), null, 2)}\n`;
}

it.runIf(process.platform === "linux")(
    "keeps exactly what Agent Base keeps of a response that did not complete",
    async () => {
        const requests = new Map<string, GymInferenceRequest[]>();
        const turns = new Map<string, GymTurn>();
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            providerIds: ["claude"],
            providerTypes: { claude: "claude" },
            models: [MODEL],
            inference(request) {
                const seen = requests.get(request.sessionId) ?? [];
                seen.push(request);
                requests.set(request.sessionId, seen);
                const turn = turns.get(request.sessionId);
                if (seen.length === 1 && turn !== undefined) return turn;
                return { content: [{ type: "text", text: "Continuing." }] };
            },
        });
        const results: Record<string, unknown> = {};
        try {
            for (const entry of CASES) {
                const agent = await gym.createSession({ title: entry.name });
                turns.set(agent.id, entry.turn);
                if (entry.abortAfterText === undefined) {
                    await gym.send(`Case ${entry.name}.`, { sessionId: agent.id });
                } else {
                    // Deltas are live-only, so the cut is observed on the event stream.
                    const stream = gym.stream("/v0/events/stream");
                    try {
                        await stream.opened();
                        await gym.send(`Case ${entry.name}.`, {
                            sessionId: agent.id,
                            wait: false,
                        });
                        const delta = entry.abortAfterText;
                        await stream.waitFor((frame) => JSON.stringify(frame).includes(delta));
                        await gym.abort(agent.id);
                    } finally {
                        stream.close();
                    }
                    await gym.waitUntil(async () =>
                        (await gym.getSession(agent.id)).status === "idle" ? true : undefined,
                    );
                }
                // Base may already have asked again on its own; otherwise a follow-up asks.
                if ((requests.get(agent.id)?.length ?? 0) < 2) {
                    await gym.send("Continue.", { sessionId: agent.id });
                }
                const [first, next] = requests.get(agent.id) ?? [];
                expect(first, `${entry.name} first request`).toBeDefined();
                expect(next, `${entry.name} next request`).toBeDefined();
                const before = first!.messages.length;
                const added = next!.messages.slice(before);
                const followUp = added.findIndex(
                    (message) => message.role === "user" || message.role === "system",
                );
                const kept = followUp === -1 ? added : added.slice(0, followUp);
                const finished = kept.filter((message) => message.role === "assistant");
                // Base's raw failure note, kept apart so a port can compare its own wording.
                const note = followUp === -1 ? undefined : added[followUp];
                results[entry.name] = {
                    name: entry.name,
                    description: entry.description,
                    model: MODEL.id,
                    stop: entry.stop,
                    toolPolicies: POLICIES,
                    turn: entry.turn,
                    ...(entry.abortAfterText === undefined
                        ? {}
                        : { abortedAfterText: entry.abortAfterText }),
                    finishedMessage: finished.length === 0 ? null : normalize(finished, agent.id),
                    settlementMessages: normalize(
                        kept.filter((message) => message.role === "tool"),
                        agent.id,
                    ),
                    keptMessages: normalize(kept, agent.id),
                    failureNote:
                        note?.role === "system"
                            ? (normalize([note], agent.id) as unknown[])[0]
                            : null,
                    nextRequestMessages: normalize(next!.messages, agent.id),
                };
            }
        } finally {
            await gym.dispose();
        }

        // Each case's expectations, written as the rules Base follows.
        const kept = (name: string) =>
            (results[name] as { keptMessages: SessionMessage[] }).keptMessages;
        expect(kept("text_partial_then_error")).toEqual([]);
        expect(kept("finished_call_then_error")).toMatchObject([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Reading it." },
                    { type: "tool_call", callId: "toolu_read_error", name: "Read" },
                ],
            },
            { role: "tool", callId: "toolu_read_error" },
        ]);
        expect(JSON.stringify(kept("server_call_without_result_then_text"))).toContain(
            "toolu_search_alone",
        );
        expect(JSON.stringify(kept("server_call_with_result"))).toContain("Read is loaded.");
        expect(JSON.stringify(kept("block_reset_mid_call"))).not.toContain("toolu_reset");
        // A reset does not take back a text block that had already finished.
        expect(kept("finished_text_reset_then_retry")).toMatchObject([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "First try." },
                    { type: "text", text: "Second try." },
                ],
            },
        ]);
        expect(JSON.stringify(kept("abort_mid_text_after_reasoning"))).not.toContain("Partial");
        expect(JSON.stringify(kept("stream_end_without_done"))).not.toContain("toolu_read_eof");
        // Only a provider error leaves a note, placed right after the kept messages.
        for (const [name, result] of Object.entries(results)) {
            const note = (result as { failureNote: SessionMessage | null }).failureNote;
            if ((result as { stop: string }).stop === "error") {
                expect(note, name).toMatchObject({
                    role: "system",
                    content: [
                        {
                            type: "text",
                            text: "The last turn failed: The provider connection failed.",
                        },
                    ],
                });
            } else {
                expect(note, name).toBeNull();
            }
        }

        if (UPDATE) await mkdir(FIXTURES, { recursive: true });
        for (const [name, result] of Object.entries(results)) {
            const path = resolve(FIXTURES, `${name}.json`);
            const json = stableJson(result);
            if (UPDATE) await writeFile(path, json);
            else expect(json, name).toBe(await readFile(path, "utf8"));
        }
    },
    600_000,
);
