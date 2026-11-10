import type { AgentGym, GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    connectCodex,
    lastMessage,
    showing,
    startGuidedGym,
} from "./support/guidedOnboardingGym.js";
import { OnboardingGyms, messagesOf } from "./support/onboardingGym.js";

/**
 * One model turn that shows a row with `show_ui` and suggests replies with `suggest_replies`,
 * the pairing onboarding's guide asks for on every tap. Clients draw a row only from a finished
 * `show_ui` call and end every call still running when its run finishes, so the run must not be
 * announced finished before its last block is. Onboarding's paced opening keeps the
 * conversation's events busy while the model answers, which is when that went wrong.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

const ROW = [{ id: "claude", type: "provider_sign_in", props: { provider: "claude" } }];
const REPLIES = ["That's all for now"];
const TEXT = "Claude Code isn't on this computer yet. Set it up here:";

type JournalEvent = { type: string; payload: Record<string, unknown> };
type Block = { type: string; name?: string; status?: string; presentation?: { type: string } };

/** Every event of one run, in journal order, through its `run.finished`. */
async function runEvents(gym: AgentGym, runId: string): Promise<JournalEvent[]> {
    const events = (await gym.client.getEvents({ limit: 2000 })).events as JournalEvent[];
    return events.filter((event) => {
        const run = event.payload["run"] as { id?: string } | undefined;
        return event.payload["runId"] === runId || run?.id === runId;
    });
}

/** The tool calls of one run's messages as each event carried them, oldest first. */
function toolStates(events: readonly JournalEvent[], name: string): string[] {
    return events.flatMap((event) => {
        const message = event.payload["message"] as { content?: Block[] } | undefined;
        return (message?.content ?? [])
            .filter((block) => block.type === "tool_call" && block.name === name)
            .map((block) => block.status ?? "");
    });
}

async function expectBothFinishedBeforeTheRun(gym: AgentGym, agentId: string): Promise<void> {
    const shown = await gym.waitUntil(async () => {
        const all = await messagesOf(gym, agentId);
        const row = all.find((message) =>
            message.content.some(
                (block) =>
                    block.type === "tool_call" &&
                    block["name"] === "show_ui" &&
                    block["status"] === "completed",
            ),
        );
        const replies = all.some((message) =>
            message.content.some(
                (block) =>
                    block.type === "tool_call" &&
                    block["name"] === "suggest_replies" &&
                    block["status"] === "completed",
            ),
        );
        return row !== undefined && replies ? row : undefined;
    }, "the row and the replies");
    const call = shown.content.find((block) => block["name"] === "show_ui") as Block | undefined;
    expect(call?.presentation?.type).toBe("ui");

    const runId = shown.runId;
    const events = await gym.waitUntil(async () => {
        const all = await runEvents(gym, runId);
        return all.some((event) => event.type === "run.finished") ? all : undefined;
    }, "the run to be announced finished");
    const finished = events.findIndex((event) => event.type === "run.finished");
    // Nothing of the run follows its end, and both calls had finished by then.
    expect(events.slice(finished + 1).map((event) => event.type)).toEqual([]);
    expect(toolStates(events, "show_ui").at(-1)).toBe("completed");
    expect(toolStates(events, "suggest_replies").at(-1)).toBe("completed");
    expect(gym.errors).toEqual([]);
}

describe("show_ui and suggest_replies in one turn", () => {
    it(
        "finishes both, one after the other, before the run",
        async () => {
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => showing(TEXT, ROW),
                shown: (request: GymInferenceRequest): GymTurn =>
                    JSON.stringify(lastMessage(request)).includes("Shown to the person")
                        ? showing("", [], REPLIES)
                        : { content: [] },
            });
            await connectCodex(gym, agentId);
            await expectBothFinishedBeforeTheRun(gym, agentId);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "finishes both, called together in one message, before the run",
        async () => {
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => showing(TEXT, ROW, REPLIES),
            });
            await connectCodex(gym, agentId);
            await expectBothFinishedBeforeTheRun(gym, agentId);
        },
        TEST_TIMEOUT_MS,
    );
});
