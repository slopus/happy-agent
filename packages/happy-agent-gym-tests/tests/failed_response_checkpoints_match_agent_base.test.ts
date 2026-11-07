import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAgentGym, type GymInferenceRequest, type GymTurn } from "@slopus/happy-agent-gym";
import type { SessionMessage } from "@slopus/happy-providers";
import { expect, it } from "vitest";

import {
    CASES,
    MODEL,
    POLICIES,
    keptFromNextRequest,
    stableJson,
} from "./support/failedResponseCases.js";

/**
 * Golden fixtures for what Agent Base keeps of a response that did not complete normally. Each
 * case streams one scripted provider response into the real daemon and its unmodified Agent Base,
 * then records the context of the next request the agent makes: that context is exactly what Base
 * persisted, with provider tool IDs, plus the results it settled for calls nobody dispatched.
 * `HAPPY_AGENT_SURFACE_UPDATE=1` rewrites the fixtures; otherwise they are compared.
 */
const FIXTURES = resolve(import.meta.dirname, "../fixtures/failed-response-checkpoints");
const UPDATE = process.env.HAPPY_AGENT_SURFACE_UPDATE === "1";

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
                    ...keptFromNextRequest(first!, next!, agent.id),
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
