import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

import type { HistoryMessage } from "../HistoryMessage.js";
import {
    foldHistorySearchText,
    historyMessageSearchParts,
} from "./messageMatchesHistoryFilters.js";
import { summarizeHistory } from "./summarizeHistory.js";

/**
 * Chat onboarding stored a person's press on an inline action as an `action` block and the
 * pressed choices as `actionChoices`. Both were removed, so a press becomes the words on the
 * control the person read and the choices are dropped, keeping every record readable. Only rows
 * that mention either are read. Recorded messages also get the statistics and search text their
 * new content implies; pending messages store neither.
 */
export async function rewriteInlineActionMessages(
    database: AgentDatabaseFacade<AgentDatabase>,
    table: string,
    recorded: boolean,
): Promise<void> {
    const rows = await agentDatabaseRows<{
        agent_id: string;
        position: number | string;
        message_json: string;
    }>(
        database,
        sql`SELECT agent_id, position, message_json FROM ${sql.raw(table)}
            WHERE message_json LIKE '%"type":"action"%'
               OR message_json LIKE '%"actionChoices"%'`,
    );
    for (const row of rows) {
        const message = JSON.parse(row.message_json) as Record<string, unknown>;
        const blocks = Array.isArray(message["blocks"]) ? (message["blocks"] as unknown[]) : [];
        let changed = "actionChoices" in message;
        delete message["actionChoices"];
        message["blocks"] = blocks.map((block) => {
            if (typeof block !== "object" || block === null) return block;
            const action = block as Record<string, unknown>;
            if (action["type"] !== "action") return block;
            changed = true;
            const label = typeof action["label"] === "string" ? action["label"] : "";
            const ticked = Array.isArray(action["ticked"])
                ? action["ticked"].filter((item): item is string => typeof item === "string")
                : [];
            const text = ticked.length > 0 ? `${label}: ${ticked.join(", ")}` : label;
            return { type: "text", text: text.length > 0 ? text : "Pressed a button" };
        });
        if (!changed) continue;
        const encoded = JSON.stringify(message);
        if (!recorded) {
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(table)} SET message_json = ${encoded}
                    WHERE agent_id = ${row.agent_id} AND position = ${row.position}`,
            );
            continue;
        }
        const rewritten = message as unknown as HistoryMessage;
        const stats = summarizeHistory([rewritten]);
        const searchText = foldHistorySearchText(historyMessageSearchParts(rewritten).join("\n"));
        await agentDatabaseRun(
            database,
            sql`UPDATE ${sql.raw(table)}
                SET message_json = ${encoded},
                    search_text = ${searchText},
                    assistant_messages = ${stats.assistantMessages},
                    user_messages = ${stats.userMessages},
                    text_characters = ${stats.textCharacters},
                    thinking_blocks = ${stats.thinkingBlocks},
                    tool_calls = ${stats.toolCalls},
                    tool_results = ${stats.toolResults}
                WHERE agent_id = ${row.agent_id} AND position = ${row.position}`,
        );
    }
}
