import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymAgentEvent,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const SKILL = "---\nname: review\ndescription: Review the changes.\n---\n\nReview carefully.";

const echoOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly mutationId?: unknown }).mutationId;

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

/** Invokes the review skill under `mutationId` and returns the run it starts. */
async function invokeReview(gym: AgentGym, agentId: string, mutationId: string): Promise<string> {
    const before = (await gym.events()).length;
    await gym.client.invokeSlashCommand(agentId, "review", {
        mode: {
            effort: gym.selection.effort,
            modelId: gym.selection.modelId,
            permissionMode: "auto",
            providerId: gym.selection.providerId,
            serviceTier: null,
        },
        mutationId,
    });
    return await gym.waitUntil(async () => {
        const started = (await gym.events())
            .slice(before)
            .find(
                (event) =>
                    event.type === "run.started" &&
                    event.payload.agentId === agentId &&
                    event.payload.mutationId === mutationId,
            );
        return started?.type === "run.started" ? started.payload.run.id : undefined;
    }, `the ${mutationId} run to start`);
}

/** The run that started with one message, once it has been announced. */
async function runStartedBy(gym: AgentGym, messageId: string): Promise<string> {
    return await gym.waitUntil(async () => {
        for (const event of await gym.events()) {
            if (
                event.type === "run.started" &&
                event.payload.acceptedMessageIds.includes(messageId)
            ) {
                return event.payload.run.id;
            }
        }
        return undefined;
    }, "the delivered message to start a run");
}

/** The run whose history holds one message. */
async function runHolding(gym: AgentGym, agentId: string, messageId: string): Promise<string> {
    const runs = (await gym.client.getMessages(agentId)).runs;
    const run = runs.find((candidate) => candidate.messages.some(({ id }) => id === messageId));
    if (run === undefined) throw new Error("The delivered message is in no run.");
    return run.id;
}

/** The ID of the message an agent received from another agent, once it is in its history. */
async function receivedMessageId(gym: AgentGym, agentId: string, text: string): Promise<string> {
    return await gym.waitUntil(async () => {
        const messages = (await gym.client.getMessages(agentId)).runs.flatMap(
            (run) => run.messages,
        );
        return messages.find(
            (message) => message.role === "agent" && JSON.stringify(message).includes(text),
        )?.id;
    }, "the delivered message to be accepted");
}

/** Every event of one run that did not echo `expected`, with what it echoed instead. */
function strayEchoes(
    events: readonly GymAgentEvent[],
    runId: string,
    expected: string,
): readonly (readonly [string, unknown])[] {
    return events
        .filter((event) => runIdOf(event) === runId)
        .flatMap((event) =>
            echoOf(event) === expected ? [] : [[event.type, echoOf(event) ?? null] as const],
        );
}

/** Every event of one run that echoed any mutation, with what it echoed. */
function anyEchoes(
    events: readonly GymAgentEvent[],
    runId: string,
): readonly (readonly [string, unknown])[] {
    return events
        .filter((event) => runIdOf(event) === runId && echoOf(event) !== undefined)
        .map((event) => [event.type, echoOf(event)] as const);
}

async function messageJoiningABusyRecipientAfterTheSendingRunSettled(
    senderMovesOn: boolean,
): Promise<void> {
    const target = gate();
    const targetStarted = gate();
    const secondRun = gate();
    const secondRunStarted = gate();
    let senderAgentId = "";
    let targetAgentId = "";
    let senderCalls = 0;
    let targetCalls = 0;
    const gym = await createAgentGym({
        files: { ".agents/skills/review/SKILL.md": SKILL },
        inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ text: "<title>Messages</title>", type: "text" }] };
            }
            if (request.sessionId === targetAgentId) {
                targetCalls += 1;
                if (targetCalls > 1) {
                    return { content: [{ text: "target answered", type: "text" }] };
                }
                // The target is answering something else, so the message waits for this answer.
                targetStarted.open();
                await target.opened;
                return { content: [{ text: "target busy", type: "text" }] };
            }
            if (request.sessionId !== senderAgentId) {
                return { content: [{ text: "unexpected agent", type: "text" }] };
            }
            senderCalls += 1;
            if (senderCalls === 1) {
                return {
                    content: [
                        {
                            arguments: {
                                explanation: "Update from the first run",
                                text: "Sent from the first run.",
                                toAgentId: targetAgentId,
                            },
                            callId: "firstrunmessage",
                            name: "send_agent_message",
                            type: "tool_call",
                        },
                    ],
                };
            }
            if (senderCalls === 2) return { content: [{ text: "message sent", type: "text" }] };
            // The sender's next run stays open until the target has answered the message.
            secondRunStarted.open();
            await secondRun.opened;
            return { content: [{ text: "second run finished", type: "text" }] };
        },
    });
    running.add(gym);
    senderAgentId = gym.defaultSessionId;
    targetAgentId = (await gym.createSession({ title: "Target" })).id;
    const busy = await gym.send("answer something else", {
        sessionId: targetAgentId,
        wait: false,
    });
    await targetStarted.opened;

    const firstRunId = await invokeReview(gym, senderAgentId, "a-echo");
    await gym.waitForRun(firstRunId);
    let secondRunId: string | undefined;
    if (senderMovesOn) {
        secondRunId = await invokeReview(gym, senderAgentId, "b-echo");
        await secondRunStarted.opened;
    }

    target.open();
    const messageId = await receivedMessageId(gym, targetAgentId, "Sent from the first run.");
    await gym.waitForRun(busy.runId);
    secondRun.open();
    if (secondRunId !== undefined) await gym.waitForRun(secondRunId);

    // The message joins the run the target was already in, which keeps the echo it had: none.
    expect(await runHolding(gym, targetAgentId, messageId)).toBe(busy.runId);
    const events = await gym.events();
    expect(
        events.filter((event) => runIdOf(event) === busy.runId).map((event) => event.type),
    ).toContain("run.finished");
    expect(anyEchoes(events, busy.runId)).toEqual([]);
    if (secondRunId !== undefined) expect(strayEchoes(events, secondRunId, "b-echo")).toEqual([]);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}

describe("a message one agent sends another", () => {
    it("echoes the run that sent it on the run it wakes an idle recipient into", async () => {
        let senderAgentId = "";
        let targetAgentId = "";
        let senderCalls = 0;
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL },
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Messages</title>", type: "text" }] };
                }
                if (request.sessionId === targetAgentId) {
                    return { content: [{ text: "target answered", type: "text" }] };
                }
                senderCalls += 1;
                if (senderCalls > 1) return { content: [{ text: "message sent", type: "text" }] };
                return {
                    content: [
                        {
                            arguments: {
                                explanation: "Update from the first run",
                                text: "Sent to an idle target.",
                                toAgentId: targetAgentId,
                            },
                            callId: "idletargetmessage",
                            name: "send_agent_message",
                            type: "tool_call",
                        },
                    ],
                };
            },
        });
        running.add(gym);
        senderAgentId = gym.defaultSessionId;
        targetAgentId = (await gym.createSession({ title: "Target" })).id;

        const sendingRunId = await invokeReview(gym, senderAgentId, "a-echo");
        await gym.waitForRun(sendingRunId);
        const messageId = await receivedMessageId(gym, targetAgentId, "Sent to an idle target.");
        const targetRunId = await runStartedBy(gym, messageId);
        await gym.waitForRun(targetRunId);

        const events = await gym.events();
        expect(
            events.filter((event) => runIdOf(event) === targetRunId).map((event) => event.type),
        ).toContain("run.finished");
        expect(strayEchoes(events, targetRunId, "a-echo")).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);

    it("leaves a busy recipient's run echo alone after the sender moved on to a tagged run", async () => {
        await messageJoiningABusyRecipientAfterTheSendingRunSettled(true);
    }, 60_000);

    it("leaves a busy recipient's run echo alone after the sending run settled", async () => {
        await messageJoiningABusyRecipientAfterTheSendingRunSettled(false);
    }, 60_000);

    it("leaves a busy parent's run echo alone when a helper's report joins it", async () => {
        const parent = gate();
        const parentBusy = gate();
        const helper = gate();
        const helperStarted = gate();
        let parentAgentId = "";
        let parentCalls = 0;
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL },
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Helper</title>", type: "text" }] };
                }
                if (request.sessionId !== parentAgentId) {
                    // The helper outlives the run that started it and reports once it finishes.
                    helperStarted.open();
                    await helper.opened;
                    return { content: [{ text: "helper result", type: "text" }] };
                }
                parentCalls += 1;
                if (parentCalls === 1) {
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Report later.",
                                    title: "Helper",
                                },
                                callId: "taggedrunspawnshelper",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (parentCalls === 2) {
                    return { content: [{ text: "helper started", type: "text" }] };
                }
                if (parentCalls === 3) {
                    // The parent is answering something else, so the report waits for this answer.
                    parentBusy.open();
                    await parent.opened;
                    return { content: [{ text: "parent busy", type: "text" }] };
                }
                return { content: [{ text: "report read", type: "text" }] };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        const spawningRunId = await invokeReview(gym, parentAgentId, "a-echo");
        await gym.waitForRun(spawningRunId);
        await helperStarted.opened;
        const busy = await gym.send("answer something else", { wait: false });
        await parentBusy.opened;
        helper.open();
        await gym.waitForEvent(
            (event) =>
                event.type === "run.finished" &&
                event.payload.agentId !== parentAgentId &&
                event.payload.run.status === "completed",
            "the helper to finish",
        );

        parent.open();
        const reportId = await receivedMessageId(gym, parentAgentId, "helper result");
        await gym.waitForRun(busy.runId);

        // The report joins the parent's untagged run instead of starting one tagged by the spawn.
        expect(await runHolding(gym, parentAgentId, reportId)).toBe(busy.runId);
        const events = await gym.events();
        expect(
            events.filter((event) => runIdOf(event) === busy.runId).map((event) => event.type),
        ).toContain("run.finished");
        expect(anyEchoes(events, busy.runId)).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});

describe("an agent another agent creates", () => {
    it("is announced with the run that created it", async () => {
        let parentAgentId = "";
        let parentCalls = 0;
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL },
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Helper</title>", type: "text" }] };
                }
                if (request.sessionId !== parentAgentId) {
                    return { content: [{ text: "helper finished", type: "text" }] };
                }
                parentCalls += 1;
                if (parentCalls > 1) return { content: [{ text: "parent done", type: "text" }] };
                return {
                    content: [
                        {
                            arguments: {
                                effort: "medium",
                                model: "gym/model",
                                provider: "gym",
                                text: "Finish at once.",
                                title: "Helper",
                            },
                            callId: "taggedruncreateshelper",
                            name: "create_agent",
                            type: "tool_call",
                        },
                    ],
                };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        const runId = await invokeReview(gym, parentAgentId, "a-echo");
        await gym.waitForRun(runId);
        const created = await gym.waitUntil(async () => {
            const events = await gym.events();
            const start = events.findIndex(
                (event) => event.type === "run.started" && event.payload.run.id === runId,
            );
            return events.slice(start).find((event) => event.type === "agent.created");
        }, "the helper to be announced");
        if (created.type !== "agent.created") throw new Error("No helper was announced.");
        const helperId = created.payload.agent.id;
        await gym.waitUntil(
            async () =>
                (await gym.events()).find(
                    (event) =>
                        event.type === "run.finished" &&
                        (event.payload as { readonly agentId?: unknown }).agentId === helperId,
                ),
            "the helper to finish",
        );

        // Not only the events that name a run: the announcement names none.
        expect(echoOf(created)).toBe("a-echo");
        const helperRun = (await gym.events()).filter(
            (event) =>
                runIdOf(event) !== undefined &&
                (event.payload as { readonly agentId?: unknown }).agentId === helperId,
        );
        expect(helperRun.map((event) => event.type)).toContain("run.finished");
        expect(helperRun.filter((event) => echoOf(event) !== "a-echo")).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});
