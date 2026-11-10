import {
    defaultModelComponent,
    defineUiComponent,
    fileTreeComponent,
    uiActionRequest,
    UI_MEMBER_PERMISSIONS,
    type UiActionBlock,
    type UiActionRequest,
    type UiPresentation,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatUiModule } from "../../sources/chatUi/index.js";
import type { HistoryMessage } from "../../sources/history/index.js";
import { AGENT_ID, chatUiWorld, type ChatUiWorld } from "./support/chatUiWorld.js";
import { contributeServiceKey, serviceKeyComponent } from "./support/serviceKeyComponent.js";

/** A control whose hook does whatever the test says next. */
const probeComponent = defineUiComponent({
    type: "probe",
    description: "A control for tests.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {
        press: { payload: Type.Object({}, { additionalProperties: false }) },
    },
});

interface Probe {
    /** What the hook does; replaced by a test. */
    press: () => Promise<unknown>;
    presses: number;
}

const worlds = new Set<ChatUiWorld>();

/** A world serving `probe` and `service_key` beside the shipped components. */
async function world(options: Parameters<typeof chatUiWorld>[0] = {}) {
    const probe: Probe = { press: () => Promise.resolve({ status: "accepted" }), presses: 0 };
    const contribute = (chatUi: ChatUiModule) => {
        contributeServiceKey(chatUi);
        chatUi.contribute(probeComponent, {
            prompt: "A control for tests.",
            fallback: () => "A probe",
            actions: {
                press: async () => {
                    probe.presses += 1;
                    return (await probe.press()) as never;
                },
            },
        });
    };
    const created = await chatUiWorld({ ...options, contribute });
    worlds.add(created);
    return { created, probe, contribute };
}

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([...worlds].map(async (created) => await created.close()));
    worlds.clear();
});

/** Show one document through `show_ui` and answer where its components are. */
async function show(created: ChatUiWorld, components: readonly Record<string, unknown>[]) {
    const shown = await created.call("show_ui", { components });
    const message = await created.history.message(created.ctx, AGENT_ID, shown.messageId);
    const block = message?.blocks.find(
        (candidate) => candidate.type === "tool_result" && candidate.callId === shown.callId,
    );
    if (block?.type !== "tool_result" || block.presentation?.type !== "ui") {
        throw new Error(`Nothing was shown: ${shown.output}`);
    }
    const presentation: UiPresentation = block.presentation;
    return {
        messageId: shown.messageId,
        uiId: presentation.ui.id,
        at: (componentId: string) => ({
            messageId: shown.messageId,
            uiId: presentation.ui.id,
            componentId,
        }),
    };
}

const PROBE = { id: "probe", type: "probe", props: {} };

function press(target: ReturnType<Awaited<ReturnType<typeof show>>["at"]>, id: string) {
    return uiActionRequest(probeComponent, "press", {}, { id, ...target });
}

function outcomeOf(record: HistoryMessage) {
    return (record.blocks[0] as UiActionBlock).outcome;
}

describe("ChatUiModule", () => {
    describe("the tools a model gets", () => {
        it("gives a person's own agent show_ui and suggest_replies", async () => {
            const { created } = await world();
            expect((await created.tools()).map((tool) => tool.name)).toEqual([
                "show_ui",
                "suggest_replies",
            ]);
        });

        it("gives none to an agent another agent manages, where nothing could be pressed", async () => {
            const { created } = await world({ parent: "bossagent" });
            expect(await created.tools()).toEqual([]);
        });

        it("gives both to a subtask, which a person talks to although an agent created it", async () => {
            const { created } = await world({ parent: "bossagent", metadata: { subtask: true } });
            expect((await created.tools()).map((tool) => tool.name)).toEqual([
                "show_ui",
                "suggest_replies",
            ]);
        });
    });

    describe("contributing", () => {
        it("refuses a second contribution of a type, a stand-in for a catalog bundle, and a missing hook", async () => {
            const { created } = await world();
            const serve = { prompt: "A tree.", fallback: () => "A tree" };

            expect(() =>
                created.chatUi.contribute(fileTreeComponent, { ...serve, actions: {} }),
            ).toThrow('The "file_tree" component is already contributed.');

            const impostor = defineUiComponent({
                type: "media",
                description: "Not the catalog's media.",
                props: Type.Object({}, { additionalProperties: false }),
                actions: {},
            });
            expect(() => created.chatUi.contribute(impostor, { ...serve, actions: {} })).toThrow(
                '"media" must be served with the catalog\'s bundle.',
            );

            const lever = defineUiComponent({
                type: "lever",
                description: "A lever.",
                props: Type.Object({}, { additionalProperties: false }),
                actions: { pull: { payload: Type.Object({}, { additionalProperties: false }) } },
            });
            expect(() =>
                created.chatUi.contribute(lever, { ...serve, actions: {} as never }),
            ).toThrow('The "lever.pull" action has no hook.');
            expect(created.chatUi.components).not.toContain("lever");
        });
    });

    describe("refusals, which store nothing", () => {
        it("answers 403 to a person who lacks the action's permission, on a first try and a replay", async () => {
            const { created } = await world();
            const shown = await show(created, [{ id: "model", type: "default_model", props: {} }]);
            const set = uiActionRequest(
                defaultModelComponent,
                "set",
                { providerId: "nobody", modelId: "nothing", effort: "high" },
                { id: "setmodel", ...shown.at("model") },
            );

            // A team member holds no `config.manage`.
            await expect(
                created.click(set, { granted: UI_MEMBER_PERMISSIONS }),
            ).rejects.toMatchObject({ status: 403, code: "forbidden" });
            expect(await created.attempts()).toEqual([]);

            // The owner's attempt is stored; the member cannot read it back by replaying its ID.
            await created.click(set);
            expect(await created.attempts()).toHaveLength(1);
            await expect(
                created.click(set, { granted: UI_MEMBER_PERMISSIONS }),
            ).rejects.toMatchObject({ status: 403 });
        });

        it("answers 404 when the offer is not a visible agent message's document and component", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);
            const at = shown.at("probe");
            const person = await created.history.record(created.ctx, AGENT_ID, {
                recordId: "personwords",
                role: "user",
                blocks: [{ type: "text", text: "Hello" }],
            });
            expect(person).toBeUndefined();

            const misses: UiActionRequest[] = [
                press({ ...at, messageId: "nosuchmessage" }, "missone"),
                press({ ...at, messageId: "Not An ID!" }, "misstwo"),
                press({ ...at, messageId: "personwords" }, "missthree"),
                press({ ...at, uiId: "nosuchdocument" }, "missfour"),
                press({ ...at, componentId: "nosuchcomponent" }, "missfive"),
            ];
            for (const miss of misses) {
                await expect(created.click(miss)).rejects.toMatchObject({
                    status: 404,
                    code: "not_found",
                });
            }
            expect(probe.presses).toBe(0);
            expect(await created.attempts()).toEqual([]);
        });

        it("answers 400 to an action that is not the component's, or a payload that is not the action's", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [
                PROBE,
                { id: "weather", type: "service_key", props: { service: "Weather" } },
                { id: "tree", type: "file_tree", props: { paths: ["a.txt"] } },
            ]);
            const request = (
                componentId: string,
                id: string,
                type: string,
                payload: Record<string, unknown>,
            ): UiActionRequest => ({ id, ...shown.at(componentId), action: { type, payload } });

            const invalid = [
                // Another component's action.
                request("probe", "badone", "service_key.remove", {}),
                // No such action, and a type that names no component.
                request("probe", "badtwo", "probe.pull", {}),
                request("probe", "badthree", "press", {}),
                // A payload missing its field, of the wrong type, and with an undeclared field.
                request("weather", "badfour", "service_key.save", {}),
                request("weather", "badfive", "service_key.save", { key: 7 }),
                request("probe", "badsix", "probe.press", { extra: true }),
                // A component with nothing to press.
                request("tree", "badseven", "file_tree.open", {}),
            ];
            for (const bad of invalid) {
                await expect(created.click(bad)).rejects.toMatchObject({
                    status: 400,
                    code: "invalid_request",
                });
            }
            expect(probe.presses).toBe(0);
            expect(await created.attempts()).toEqual([]);
        });

        it("answers 409 when the click's ID is already a message or a queued one, as send does", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);
            await created.history.queuePending(created.ctx, {
                id: "queuedwords",
                agentId: AGENT_ID,
                role: "user",
                status: "pending",
                delivery: "queue",
                createdAt: Date.now(),
                blocks: [{ type: "text", text: "One more thing" }],
                mode: {
                    providerId: "codex",
                    modelId: "gpt-test",
                    effort: "high",
                    serviceTier: null,
                    permissionMode: "auto",
                },
                runId: null,
            });

            for (const id of [shown.messageId, "queuedwords"]) {
                await expect(created.click(press(shown.at("probe"), id))).rejects.toMatchObject({
                    status: 409,
                    code: "conflict",
                    message: "The ID is already in use.",
                });
            }
            expect(probe.presses).toBe(0);
            expect(await created.attempts()).toEqual([]);
            // The message whose ID was borrowed is untouched.
            expect(
                (await created.history.message(created.ctx, AGENT_ID, shown.messageId))?.role,
            ).toBe("assistant");
        });

        it("answers 429 after 20 actions on one component in a minute, and counts each component alone", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE, { id: "other", type: "probe", props: {} }]);

            for (let index = 0; index < 20; index += 1) {
                await created.click(
                    press(shown.at("probe"), `press${String(index).padStart(2, "0")}x`),
                );
            }
            await expect(
                created.click(press(shown.at("probe"), "presstoomany")),
            ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
            expect(probe.presses).toBe(20);
            expect(await created.attempts()).toHaveLength(20);

            // A replay of a stored attempt is not a new action, and another component is its own.
            await created.click(press(shown.at("probe"), "press00x"));
            await created.click(press(shown.at("other"), "pressother"));
            expect(probe.presses).toBe(21);
        });
    });

    describe("a repeated ID", () => {
        it("answers the stored attempt without running the hook again, and without its result", async () => {
            const { created } = await world();
            const shown = await show(created, [
                { id: "weather", type: "service_key", props: { service: "Weather" } },
            ]);
            const save = (key: string) =>
                uiActionRequest(
                    serviceKeyComponent,
                    "save",
                    { key },
                    { id: "saveonce", ...shown.at("weather") },
                );

            const first = await created.click(save("key-first"));
            expect(first.result).toEqual({ replaced: false });

            // The retry may even carry a payload that would be refused: it is not read again.
            const again = await created.click(save("not-a-key"));
            expect(again.record).toEqual(first.record);
            // A result is returned once and never stored, so a replay has none.
            expect(again.result).toBeNull();
            expect(await created.attempts()).toEqual([{ id: "saveonce", status: "accepted" }]);
            expect(created.wakes).toHaveLength(1);
        });

        it("takes two sends of one new ID one after the other, so the hook runs once", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);
            const request = press(shown.at("probe"), "doubletap");

            const [first, second] = await Promise.all([
                created.click(request),
                created.click(request),
            ]);

            expect(probe.presses).toBe(1);
            expect(second.record).toEqual(first.record);
            expect(await created.attempts()).toEqual([{ id: "doubletap", status: "accepted" }]);
        });
    });

    describe("an attempt never stays pending", () => {
        it("stores a hook's code and reason within the record's limits, as one plain line", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);
            probe.press = () =>
                Promise.resolve({
                    status: "rejected",
                    code: "c".repeat(300),
                    reason: `No.\n${"r".repeat(2_000)}`,
                });

            const answer = await created.click(press(shown.at("probe"), "longwinded"));

            const outcome = outcomeOf(answer.record);
            expect(outcome.status).toBe("rejected");
            expect(outcome.code).toBe("c".repeat(64));
            expect(outcome.reason).toHaveLength(500);
            expect(outcome.reason?.startsWith("No. rrr")).toBe(true);
            expect(await created.attempts()).toEqual([{ id: "longwinded", status: "rejected" }]);
            // What was stored is what was answered and announced.
            expect(await created.history.message(created.ctx, AGENT_ID, "longwinded")).toEqual(
                answer.record,
            );
            expect(created.updated.at(-1)).toEqual(answer.record);
        });

        it("fails an attempt whose hook throws or answers nonsense, logging only the error's kind", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);

            probe.press = () => Promise.reject(new TypeError("the request held hunter2"));
            const thrown = await created.click(press(shown.at("probe"), "hookthrows"));
            expect(outcomeOf(thrown.record)).toEqual({
                status: "failed",
                reason: "Something went wrong. Try again.",
            });

            for (const [id, nonsense] of [
                ["hooknothing", undefined],
                ["hookstatus", { status: "done" }],
                ["hookreject", { status: "rejected" }],
            ] as const) {
                probe.press = () => Promise.resolve(nonsense);
                expect(
                    outcomeOf((await created.click(press(shown.at("probe"), id))).record),
                ).toEqual({
                    status: "failed",
                    reason: "Something went wrong. Try again.",
                });
            }

            expect((await created.attempts()).map((attempt) => attempt.status)).toEqual([
                "failed",
                "failed",
                "failed",
                "failed",
            ]);
            const logged = created.logs.join("\n");
            expect(logged).toContain("TypeError");
            expect(logged).not.toContain("hunter2");
        });

        it("fails an attempt whose note could not wake the model, keeping nothing of the outcome", async () => {
            const { created } = await world({ failWake: true });
            const shown = await show(created, [
                { id: "weather", type: "service_key", props: { service: "Weather" } },
            ]);

            const answer = await created.click(
                uiActionRequest(
                    serviceKeyComponent,
                    "save",
                    { key: "key-0123456789" },
                    { id: "wakefails", ...shown.at("weather") },
                ),
            );

            expect(outcomeOf(answer.record)).toEqual({
                status: "failed",
                reason: "Something went wrong. Try again.",
            });
            expect(answer.result).toBeNull();
            expect(await created.attempts()).toEqual([{ id: "wakefails", status: "failed" }]);
            // The note belonged to the outcome that was not applied, so no later turn reads it.
            expect(await created.nextTurnNotes()).toEqual([]);
            expect(await created.everything()).not.toContain("key-0123456789");
        });

        it("fails an attempt whose hook takes longer than 15 seconds", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);
            probe.press = () => new Promise(() => undefined);
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

            const clicked = created.click(press(shown.at("probe"), "tooslow"));
            await vi.waitFor(() => expect(probe.presses).toBe(1));
            expect(await created.attempts()).toEqual([{ id: "tooslow", status: "pending" }]);
            await vi.advanceTimersByTimeAsync(15_000);

            expect(outcomeOf((await clicked).record)).toEqual({
                status: "failed",
                code: "timeout",
                reason: "That took too long. Try again.",
            });
            expect(await created.attempts()).toEqual([{ id: "tooslow", status: "failed" }]);
        });

        it("fails an attempt the daemon stopped in the middle of, when it starts again", async () => {
            const { created, probe, contribute } = await world();
            const shown = await show(created, [PROBE]);
            let release!: (outcome: unknown) => void;
            const stuck = new Promise((resolve) => (release = resolve));
            probe.press = () => stuck;

            const clicked = created.click(press(shown.at("probe"), "cutshort"));
            await vi.waitFor(() => expect(probe.presses).toBe(1));
            expect(await created.attempts()).toEqual([{ id: "cutshort", status: "pending" }]);

            // The daemon starts again over the same database, with no hook left running.
            const restarted = await created.restart(contribute);
            worlds.add(restarted);
            await vi.waitFor(async () =>
                expect(await restarted.attempts()).toEqual([{ id: "cutshort", status: "failed" }]),
            );

            const record = await restarted.history.message(restarted.ctx, AGENT_ID, "cutshort");
            expect(outcomeOf(record!)).toEqual({
                status: "failed",
                code: "interrupted",
                reason: "Happy restarted before this finished. Try again.",
            });
            expect(restarted.updated.map((announced) => announced.recordId)).toEqual(["cutshort"]);
            // The person presses again under a new ID, and that attempt is its own.
            probe.press = () => Promise.resolve({ status: "accepted" });
            const retried = await restarted.click(press(shown.at("probe"), "secondtry"));
            expect(outcomeOf(retried.record).status).toBe("accepted");

            // Let the stopped process's hook go, so nothing is left hanging after the test.
            release({ status: "accepted" });
            await clicked.catch(() => undefined);
        });
    });

    describe("results and notes", () => {
        it("answers no result for one the action does not declare", async () => {
            const { created, probe } = await world();
            const shown = await show(created, [PROBE]);
            probe.press = () => Promise.resolve({ status: "accepted", result: { extra: "data" } });

            const answer = await created.click(press(shown.at("probe"), "undeclared"));

            expect(outcomeOf(answer.record)).toEqual({ status: "accepted" });
            expect(answer.result).toBeNull();
        });

        it("keeps a note for the next turn, and wakes the model with every waiting note in order", async () => {
            const { created } = await world();

            await created.chatUi.note(created.ctx, AGENT_ID, "The first thing happened.");
            await created.chatUi.note(created.ctx, AGENT_ID, "The second thing happened.");
            expect(created.wakes).toEqual([]);

            await created.chatUi.note(created.ctx, AGENT_ID, "The third thing happened.", true);
            expect(created.wakes).toEqual([
                {
                    agentId: AGENT_ID,
                    text: "<happy-note>\nThe first thing happened.\nThe second thing happened.\nThe third thing happened.\n</happy-note>",
                    hideFromUser: true,
                },
            ]);
            // The turn that was started carries them, so the next one reads none again.
            expect(await created.nextTurnNotes()).toEqual([]);
        });
    });

    describe("what the daemon writes itself", () => {
        it("refuses an empty message and replies that fail their checks", async () => {
            const { created } = await world();

            await expect(created.chatUi.post(created.ctx, AGENT_ID, {})).rejects.toThrow(
                "The daemon wrote an empty message.",
            );
            await expect(
                created.chatUi.post(created.ctx, AGENT_ID, { replies: ["Yes", "Yes"] }),
            ).rejects.toThrow("The daemon wrote invalid replies");
            expect(created.appended).toEqual([]);
        });
    });
});
