import { sql } from "drizzle-orm";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const press = {
    role: "user",
    recordId: "pressrecord",
    at: 1,
    blocks: [
        {
            type: "action",
            messageId: "offerrecord",
            blockIndex: 0,
            actionId: "onboarding.routesUse",
            params: {},
            values: ["codex"],
            label: "Use selected",
            ticked: ["Codex in the ChatGPT app"],
            outcome: "Adding what they ticked.",
            result: null,
        },
    ],
};
const offer = {
    role: "agent",
    recordId: "offerrecord",
    at: 0,
    blocks: [{ type: "text", text: "Which AI should I use?" }],
    actionChoices: { "0": { kind: "checklist", values: ["codex"] } },
};

describe("history inline action migration", () => {
    it("rewrites a stored press as the words the person read and drops the pressed choices", async () => {
        const history = new HistoryModule();
        const earlier = history.migrations.filter(
            ([key]) => key !== "004-history-inline-actions-as-text",
        );
        const migration = history.migrations.find(
            ([key]) => key === "004-history-inline-actions-as-text",
        );
        if (migration === undefined) throw new Error("Expected the inline action migration.");
        const database = moduleDatabase(earlier, "history-inline-action-migration");
        await database.ready;
        try {
            for (const [position, message] of [offer, press].entries()) {
                await agentDatabaseRun(
                    database.database,
                    sql`INSERT INTO happy_agent_module_history
                        (agent_id, position, record_id, role, message_json, search_text,
                         assistant_messages, user_messages, text_characters, thinking_blocks,
                         tool_calls, tool_results)
                        VALUES ('happyagent', ${position}, ${message.recordId}, ${message.role},
                                ${JSON.stringify(message)}, '', 0, 0, 0, 0, 0, 0)`,
                );
            }
            await migration[1](database.context, database.database);

            const page = await history.read(database.context, "happyagent", { from: "start" });
            expect(page.messages.map(({ message }) => message)).toEqual([
                {
                    role: "agent",
                    recordId: "offerrecord",
                    at: 0,
                    blocks: [{ type: "text", text: "Which AI should I use?" }],
                },
                {
                    role: "user",
                    recordId: "pressrecord",
                    at: 1,
                    blocks: [{ type: "text", text: "Use selected: Codex in the ChatGPT app" }],
                },
            ]);
        } finally {
            database.close();
        }
    });
});
