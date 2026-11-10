import {
    knownUiComponent,
    uiActionRequest,
    uiActionResult,
    uiDocumentFallback,
    type UiActionResponse,
    type UiPresentation,
} from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

import { messageResource } from "../../sources/api/ApiMessageProjection.js";
import type { HistoryMessage } from "../../sources/history/index.js";
import { AGENT_ID, chatUiWorld, type ChatUiWorld } from "./support/chatUiWorld.js";
import { contributeServiceKey, serviceKeyComponent } from "./support/serviceKeyComponent.js";

/**
 * The chat UI API in five examples, each run against the real module. They are the examples in
 * this module's README; a change that breaks one changes the contract.
 *
 * Examples 3 and 5 use `service_key`, a component only these tests have (see
 * `support/serviceKeyComponent.ts`): it is contributed the way any module contributes one, so
 * what they show holds for every component.
 */

const worlds = new Set<ChatUiWorld>();
async function world(options: Parameters<typeof chatUiWorld>[0] = {}): Promise<ChatUiWorld> {
    const created = await chatUiWorld(options);
    worlds.add(created);
    return created;
}

/** A world whose server also serves `service_key`, and the keys its hooks were given. */
async function worldWithServiceKey() {
    let keys = new Map<string, string>();
    const created = await world({
        contribute: (chatUi) => {
            keys = contributeServiceKey(chatUi);
        },
    });
    return { created, keys };
}

afterEach(async () => {
    await Promise.all([...worlds].map(async (created) => await created.close()));
    worlds.clear();
});

/** The presentation a completed call left on its message. */
function presentationOf(message: HistoryMessage | undefined, callId: string) {
    for (const block of message?.blocks ?? []) {
        if (block.type === "tool_result" && block.callId === callId) return block.presentation;
    }
    return undefined;
}

describe("the chat UI API in five examples", () => {
    it("1. a model shows UI with show_ui, and the completed call carries the document", async () => {
        const { call, history, ctx } = await world();

        const shown = await call("show_ui", {
            components: [
                {
                    id: "layout",
                    type: "file_tree",
                    props: { paths: ["src/app.ts", "src/ui/row.tsx"] },
                },
                { id: "model", type: "default_model", props: {} },
            ],
        });

        // Stored on the completed call as its presentation, which is what clients draw.
        const message = await history.message(ctx, AGENT_ID, shown.messageId);
        expect(presentationOf(message, shown.callId)).toEqual({
            type: "ui",
            items: [],
            ui: {
                id: expect.stringMatching(/^[a-z][a-z0-9]{23}$/),
                components: [
                    {
                        id: "layout",
                        type: "file_tree",
                        fallback: "src/app.ts, src/ui/row.tsx",
                        props: { paths: ["src/app.ts", "src/ui/row.tsx"] },
                    },
                    {
                        id: "model",
                        type: "default_model",
                        fallback: "The default model is in Settings.",
                        props: {},
                    },
                ],
            },
        });
        // The model is told what the person now sees, one fallback line per component.
        expect(shown.output).toContain("- layout (file_tree): src/app.ts, src/ui/row.tsx");

        // A bad call fails with every problem as a sentence the model can act on, and nothing
        // is shown.
        const bad = await call("show_ui", {
            components: [
                { id: "tree", type: "file_tree", props: { paths: [] } },
                { id: "model", type: "default_model", props: { model: "the-best-one" } },
                { id: "extra", type: "slideshow", props: {} },
            ],
        });
        expect(bad.output).toContain("Nothing was shown. Fix these and call show_ui again:");
        expect(bad.output).toContain("- tree: the file_tree props are invalid");
        expect(bad.output).toContain("- model: the default_model props are invalid");
        expect(bad.output).toContain('- extra: there is no "slideshow" component here.');
        expect(
            presentationOf(await history.message(ctx, AGENT_ID, bad.messageId), bad.callId),
        ).toBeUndefined();
    });

    it("2. a module shows UI with no model, in a ui block of an agent message", async () => {
        const { chatUi, history, ctx, appended, wakes } = await world();

        const message = await chatUi.post(ctx, AGENT_ID, {
            text: "Pick the model new conversations start with.",
            components: [{ id: "model", type: "default_model", props: {} }],
            replies: ["Keep it as it is"],
        });

        expect(message.role).toBe("assistant");
        expect(message.blocks).toEqual([
            { type: "text", text: "Pick the model new conversations start with." },
            {
                type: "ui",
                ui: {
                    id: expect.any(String),
                    components: [
                        {
                            id: "model",
                            type: "default_model",
                            fallback: "The default model is in Settings.",
                            props: {},
                        },
                    ],
                },
            },
            { type: "quick_replies", options: ["Keep it as it is"] },
        ]);
        // It is announced like any message and starts no turn. With no run open, it is stored in a
        // finished run of its own, so every reader of the conversation's runs finds it.
        expect(appended.map((announced) => announced.recordId)).toEqual([message.recordId]);
        expect(wakes).toEqual([]);
        expect(await history.run(ctx, AGENT_ID, message.runId!)).toMatchObject({
            status: "completed",
        });

        // A document the daemon wrote wrong throws: nothing half-valid is stored.
        await expect(
            chatUi.post(ctx, AGENT_ID, {
                components: [{ id: "tree", type: "file_tree", props: { paths: [] } }],
            }),
        ).rejects.toThrow("The daemon wrote an invalid document");
        expect(appended).toHaveLength(1);
    });

    it("3. a click with a secret is recorded, handled, and leaves the secret nowhere", async () => {
        const { created, keys } = await worldWithServiceKey();
        const { call, click, history, ctx } = created;
        const shown = await call("show_ui", {
            components: [{ id: "weather", type: "service_key", props: { service: "Weather" } }],
        });
        const presentation = presentationOf(
            await history.message(ctx, AGENT_ID, shown.messageId),
            shown.callId,
        ) as UiPresentation;
        const target = {
            messageId: shown.messageId,
            uiId: presentation.ui.id,
            componentId: "weather",
        };
        const key = "key-0123456789abcdefghijklmn";

        // The typed request a client builds: the action and its payload come from the bundle.
        const answer = await click(
            uiActionRequest(serviceKeyComponent, "save", { key }, { id: "attemptone", ...target }),
        );

        // The attempt record: a service message with one action block, the secret left out.
        expect(messageResource(answer.record)).toMatchObject({
            id: "attemptone",
            role: "service",
            content: [
                {
                    type: "action",
                    messageId: shown.messageId,
                    uiId: presentation.ui.id,
                    componentId: "weather",
                    action: { type: "service_key.save", payload: {} },
                    outcome: { status: "accepted" },
                },
            ],
        });
        // The action's result goes to the caller alone, typed by the bundle.
        const response: Pick<UiActionResponse, "result"> = { result: answer.result };
        expect(uiActionResult(serviceKeyComponent, "save", response)).toEqual({ replaced: false });
        expect(await created.attempts()).toEqual([{ id: "attemptone", status: "accepted" }]);
        // The record was announced pending when stored and again when its outcome settled.
        expect(created.appended.at(-1)?.blocks[0]).toMatchObject({
            type: "action",
            outcome: { status: "pending" },
        });
        expect(created.updated.at(-1)?.blocks[0]).toMatchObject({
            type: "action",
            outcome: { status: "accepted" },
        });
        // The hook received the secret and did the work, and its note woke the model in a hidden
        // turn of its own.
        expect(keys.get("Weather")).toBe(key);
        expect(created.wakes).toEqual([
            {
                agentId: AGENT_ID,
                text: "<happy-note>\nWeather is connected.\n</happy-note>",
                hideFromUser: true,
            },
        ]);

        // A key the module refuses is the person's answer, not an error: a rejected outcome,
        // with no result and no note.
        const refusedKey = "nope-0123456789abcdefghijklm";
        const refused = await click(
            uiActionRequest(
                serviceKeyComponent,
                "save",
                { key: refusedKey },
                { id: "attempttwo", ...target },
            ),
        );
        expect(refused.record.blocks[0]).toMatchObject({
            action: { type: "service_key.save", payload: {} },
            outcome: {
                status: "rejected",
                code: "key_rejected",
                reason: "That doesn't look like a Weather key.",
            },
        });
        expect(refused.result).toBeNull();
        expect(created.wakes).toHaveLength(1);

        // Neither key is in any table, announcement, hidden message, stored value, or log line.
        const everything = await created.everything();
        expect(everything).toContain("attemptone");
        expect(everything).not.toContain(key);
        expect(everything).not.toContain(refusedKey);
    });

    it("4. quick replies are suggested by the model, and a tap is checked against them", async () => {
        const { call, chatUi, history, ctx } = await world();

        const suggested = await call("suggest_replies", {
            options: ["Merge it", "  Show me   the diff ", "Not now"],
        });

        // Stored on the completed call, each option with its whitespace collapsed.
        const message = await history.message(ctx, AGENT_ID, suggested.messageId);
        expect(presentationOf(message, suggested.callId)).toEqual({
            type: "quick_replies",
            options: ["Merge it", "Show me the diff", "Not now"],
        });

        // A tap is an ordinary send naming the option. The daemon checks only that the option
        // exists in a visible agent message here and that the text equals it exactly.
        const tapped = {
            messageId: suggested.messageId,
            toolCallId: suggested.callId,
            index: 1,
        };
        expect(
            await chatUi.quickReplyProblem(ctx, AGENT_ID, tapped, "Show me the diff"),
        ).toBeUndefined();
        expect(await chatUi.quickReplyProblem(ctx, AGENT_ID, tapped, "Show me the code")).toBe(
            "The text must be the suggested reply exactly.",
        );
        expect(
            await chatUi.quickReplyProblem(ctx, AGENT_ID, { ...tapped, index: 5 }, "Later"),
        ).toBe("That suggestion has no such option.");
        expect(
            await chatUi.quickReplyProblem(
                ctx,
                AGENT_ID,
                { ...tapped, messageId: "elsewhere" },
                "Merge it",
            ),
        ).toBe("That suggestion isn't in this conversation.");

        // Replies the daemon wrote itself are named by their message alone.
        const posted = await chatUi.post(ctx, AGENT_ID, { text: "Ready?", replies: ["Go"] });
        expect(
            await chatUi.quickReplyProblem(
                ctx,
                AGENT_ID,
                { messageId: posted.recordId, index: 0 },
                "Go",
            ),
        ).toBeUndefined();
    });

    it("5. a new component is one bundle and one contribution, with nothing else changed", async () => {
        // The bundle and the contribution are `support/serviceKeyComponent.ts`, whole. Nothing in
        // chat UI, History, the API, or the client catalog names `service_key`.
        const { created } = await worldWithServiceKey();
        const { call, click, chatUi, history, ctx } = created;

        // The server now serves it: capabilities list it, and show_ui accepts and teaches it.
        expect(chatUi.components).toEqual(["file_tree", "default_model", "service_key"]);
        const showUi = (await created.tools()).find((tool) => tool.name === "show_ui");
        expect(showUi?.description).toContain("- service_key: One outside service's API key");

        const shown = await call("show_ui", {
            components: [{ id: "maps", type: "service_key", props: { service: "Maps" } }],
        });
        const presentation = presentationOf(
            await history.message(ctx, AGENT_ID, shown.messageId),
            shown.callId,
        ) as UiPresentation;
        expect(presentation.ui.components).toEqual([
            {
                id: "maps",
                type: "service_key",
                fallback: "Connect Maps in Happy on your computer",
                props: { service: "Maps" },
            },
        ]);

        // A client that has no drawer for the type yet reads the document and shows its fallback.
        expect(knownUiComponent(presentation.ui.components[0]!)).toBeUndefined();
        expect(uiDocumentFallback(presentation.ui)).toBe("Connect Maps in Happy on your computer");

        // A client that has one sends typed clicks and reads typed results.
        const target = {
            messageId: shown.messageId,
            uiId: presentation.ui.id,
            componentId: "maps",
        };
        await click(
            uiActionRequest(
                serviceKeyComponent,
                "save",
                { key: "key-first" },
                { id: "savefirst", ...target },
            ),
        );
        const again = await click(
            uiActionRequest(
                serviceKeyComponent,
                "save",
                { key: "key-second" },
                { id: "savesecond", ...target },
            ),
        );
        expect(uiActionResult(serviceKeyComponent, "save", again)).toEqual({ replaced: true });

        // Each action names the permission its person must hold; one who lacks it stores nothing.
        const remove = uiActionRequest(
            serviceKeyComponent,
            "remove",
            {},
            { id: "remove", ...target },
        );
        await expect(
            click(remove, { granted: ["content.write", "providers.own"] }),
        ).rejects.toMatchObject({ status: 403, code: "forbidden" });
        expect((await created.attempts()).map((attempt) => attempt.id)).toEqual([
            "savefirst",
            "savesecond",
        ]);

        // An action with no result answers none. Without `wake`, its note waits for the
        // conversation's next turn and joins it hidden.
        const removed = await click(remove);
        expect(removed.result).toBeNull();
        expect(created.wakes).toHaveLength(2);
        expect(await created.nextTurnNotes()).toEqual([
            "<happy-note>\nMaps was disconnected.\n</happy-note>",
        ]);
        expect(await created.nextTurnNotes()).toEqual([]);
    });
});
