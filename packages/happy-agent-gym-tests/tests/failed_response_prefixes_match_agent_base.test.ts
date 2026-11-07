import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAgentGym, type GymInferenceRequest, type GymTurn } from "@slopus/happy-agent-gym";
import type { SessionEvent } from "@slopus/happy-providers";
import { expect, it } from "vitest";

import {
    CASES,
    MODEL,
    POLICIES,
    keptFromNextRequest,
    normalize,
    stableJson,
    type Case,
} from "./support/failedResponseCases.js";

/**
 * Prefix fixtures for the failed-response goldens. Each golden's response is replayed into the
 * real daemon and its unmodified Agent Base, held open after every one of its events in turn, and
 * aborted there. Each cut records what the agent had published when the stream stopped after that
 * event, then what Base kept once aborted, read from the next request's context as the goldens are.
 * A port killed after the same event can compare both. `HAPPY_AGENT_SURFACE_UPDATE=1` rewrites the
 * fixtures; otherwise they are compared.
 */
const FIXTURES = resolve(import.meta.dirname, "../fixtures/failed-response-prefixes");
const UPDATE = process.env.HAPPY_AGENT_SURFACE_UPDATE === "1";

/** The exact events a case streams, expanding a `content` turn as the gym streams it. */
function caseEvents(entry: Case): readonly SessionEvent[] {
    if (entry.turn.events !== undefined) return entry.turn.events;
    const size = entry.turn.textDeltaChunkSize;
    const events: SessionEvent[] = [];
    for (const block of entry.turn.content ?? []) {
        events.push({ type: "block_start" });
        if (block.type === "reasoning") {
            events.push(
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: block.text },
                { type: "reasoning_end", reasoning: block.text },
            );
        } else if (block.type === "text") {
            events.push({ type: "text_start" });
            for (let index = 0; index < block.text.length; index += size ?? block.text.length) {
                events.push({
                    type: "text_delta",
                    delta: block.text.slice(index, index + (size ?? block.text.length)),
                });
            }
            events.push({ type: "text_end" });
        } else {
            throw new Error(`${entry.name} streams a block these fixtures do not expand.`);
        }
        events.push({ type: "block_stop" });
    }
    const usage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, totalTokens: 0 };
    events.push(
        { type: "token_usage", usage },
        { type: "done", state: "normal", tokens: { input: 0, output: 0 } },
    );
    return events;
}

/** Every point the stream can stop: after each event, but not after the one that ends it. */
function cutPoints(events: readonly SessionEvent[]): readonly number[] {
    return events.flatMap((event, index) => (event.type === "done" ? [] : [index + 1]));
}

it.runIf(process.platform === "linux")(
    "publishes and keeps exactly what Agent Base does when a response stops after each event",
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
        const results: Record<
            string,
            { cuts: Record<string, unknown>[] } & Record<string, unknown>
        > = {};
        try {
            for (const entry of CASES) {
                const events = caseEvents(entry);
                const cuts: Record<string, unknown>[] = [];
                for (const afterEvents of cutPoints(events)) {
                    const agent = await gym.createSession({
                        title: `${entry.name} after ${String(afterEvents)}`,
                    });
                    let reached: () => void = () => {};
                    const held = new Promise<void>((resolveHeld) => (reached = resolveHeld));
                    turns.set(agent.id, { events, hold: { afterEvents, onHeld: reached } });
                    await gym.send(`Case ${entry.name}.`, { sessionId: agent.id, wait: false });
                    await held;
                    // Base asks for the next event only after handling the last one, so this is
                    // everything it had published when the stream stopped there.
                    const history = await gym.history(agent.id);
                    // Public block IDs are generated by the daemon, unlike provider tool IDs, so
                    // they are numbered in order of appearance.
                    let publicIds = 0;
                    const published = history.runs
                        .flatMap((run) => run.messages)
                        .filter((message) => message.role === "agent")
                        .map((message) => ({
                            role: message.role,
                            content: message.content.map((block) =>
                                "id" in block
                                    ? { ...block, id: `{{publicId:${String(++publicIds)}}}` }
                                    : block,
                            ),
                        }));
                    await gym.abort(agent.id);
                    await gym.waitUntil(async () =>
                        (await gym.getSession(agent.id)).status === "idle" ? true : undefined,
                    );
                    await gym.send("Continue.", { sessionId: agent.id });
                    const [first, next] = requests.get(agent.id) ?? [];
                    expect(first, `${entry.name} after ${String(afterEvents)}`).toBeDefined();
                    expect(next, `${entry.name} after ${String(afterEvents)}`).toBeDefined();
                    cuts.push({
                        afterEvents,
                        lastEvent: events[afterEvents - 1],
                        publishedAtCut: normalize(
                            published as unknown as Parameters<typeof normalize>[0],
                            agent.id,
                        ),
                        ...keptFromNextRequest(first!, next!, agent.id),
                    });
                }
                results[entry.name] = {
                    name: entry.name,
                    description: entry.description,
                    model: MODEL.id,
                    stop: "cancelled",
                    toolPolicies: POLICIES,
                    events,
                    cuts,
                };
            }
        } finally {
            await gym.dispose();
        }

        const cut = (name: string, lastEventType: string, occurrence = 1) =>
            results[name]!.cuts.filter(
                (entry) => (entry.lastEvent as SessionEvent).type === lastEventType,
            )[occurrence - 1] as {
                publishedAtCut: unknown;
                keptMessages: unknown;
            };
        // A provider-run call without a result is neither published nor kept when cut short.
        const searchEnded = cut("server_call_without_result_then_text", "toolcall_end");
        expect(JSON.stringify(searchEnded.publishedAtCut)).not.toContain("toolu_search_alone");
        expect(JSON.stringify(searchEnded.keptMessages)).not.toContain("toolu_search_alone");
        // Finished reasoning survives an abort right after it ends.
        expect(
            JSON.stringify(cut("abort_mid_text_after_reasoning", "reasoning_end").keptMessages),
        ).toContain("Thinking it through.");
        // A text block finished after a reset is kept when the stream stops right after it.
        expect(
            JSON.stringify(cut("finished_text_reset_then_retry", "text_end", 2).keptMessages),
        ).toContain("Second try.");

        if (UPDATE) await mkdir(FIXTURES, { recursive: true });
        for (const [name, result] of Object.entries(results)) {
            const path = resolve(FIXTURES, `${name}.json`);
            const json = stableJson(result);
            if (UPDATE) await writeFile(path, json);
            else expect(json, name).toBe(await readFile(path, "utf8"));
        }
    },
    900_000,
);
