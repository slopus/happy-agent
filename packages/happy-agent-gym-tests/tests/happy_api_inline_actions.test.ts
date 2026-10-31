import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import type { SendActionMessageRequest } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const text = (value: string): GymTurn => ({ content: [{ type: "text", text: value }] });
const MENU = [
    "Here is the draft. Want it?",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>Use this draft</button>',
    '  <button data-action="reply" data-text="Make it shorter, please">Shorter</button>',
    "</menu>",
    "",
].join("\n");
const CHOSEN = { actionChoices: { "0": { kind: "button", index: 0 } } };

describe("inline actions", () => {
    it("sends a press as the person's words, locks its menu, and refuses forged or later presses", async () => {
        const gym = await createAgentGym({
            inference: [text(MENU), text("Sent as is.")],
        });
        running.add(gym);
        const agentId = gym.defaultSessionId;
        expect((await gym.client.getHealth()).capabilities).toMatchObject({ chatActions: true });
        await gym.send("Draft the reply to Steve.");
        const history = async () =>
            (await gym.client.getMessages(agentId)).runs.flatMap((run) => run.messages);
        const offered = (await history()).find((message) => message.role === "agent")!;
        expect(offered).not.toHaveProperty("actionChoices");

        const press = async (
            controlIndex: number,
            params: Record<string, string>,
            options: { id?: string; messageId?: string } = {},
        ) => {
            const request: SendActionMessageRequest = {
                ...(options.id === undefined ? {} : { id: options.id }),
                content: [
                    {
                        type: "action",
                        messageId: options.messageId ?? offered.id,
                        blockIndex: 0,
                        controlIndex,
                        actionId: "reply",
                        params,
                    },
                ],
                mode: { ...gym.selection, permissionMode: "workspace_write" },
            };
            return await gym.http.post(`/v0/agents/${agentId}/send`, request);
        };

        // A press that does not match a button the agent wrote is refused and locks nothing.
        expect((await press(1, { text: "Ship it now" })).status).toBe(400);
        expect((await press(2, {})).status).toBe(400);
        expect((await press(0, { text: "Use this draft" })).status).toBe(400);
        const elsewhere = { messageId: "tz4a98xxat96iws9zmbrgj3a" };
        expect((await press(0, {}, elsewhere)).status).toBe(404);
        expect((await history()).find((message) => message.id === offered.id)).not.toHaveProperty(
            "actionChoices",
        );

        // The real press is the person's own words, which wake the agent.
        const pressed = await press(0, {});
        expect(pressed.status).toBe(202);
        const sent = (pressed.body as { message: { id: string; content: unknown } }).message;
        expect(sent.content).toEqual([{ type: "text", text: "Use this draft" }]);
        await gym.waitForEvent(
            (event) =>
                event.type === "run.finished" &&
                gym.inference.userTexts().includes("Use this draft"),
            "the run the press woke",
        );
        const updated = await gym.waitForEvent(
            (event) =>
                event.type === "message.updated" &&
                JSON.stringify(event.payload).includes('"actionChoices"'),
            "the pressed message's update",
        );
        expect(updated.payload).toMatchObject({ message: { id: offered.id, ...CHOSEN } });
        const after = await history();
        expect(after.find((message) => message.id === offered.id)).toMatchObject(CHOSEN);
        expect(after.find((message) => message.id === sent.id)).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "Use this draft" }],
        });

        // The menu is locked: another press conflicts, and resending the same ID is that message.
        expect((await press(1, { text: "Make it shorter, please" })).status).toBe(409);
        const repeated = await press(0, {}, { id: sent.id });
        expect(repeated.status).toBe(202);
        expect(repeated.body).toMatchObject({ message: { id: sent.id } });

        // The choice is durable.
        await gym.restart();
        expect((await history()).find((message) => message.id === offered.id)).toMatchObject(
            CHOSEN,
        );
        expect(gym.inference.unscripted).toEqual([]);
    });
});
