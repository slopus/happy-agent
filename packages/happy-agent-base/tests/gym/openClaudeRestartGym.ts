import type { BaseProvider, SessionEvent } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import {
    AgentBase,
    AgentProviders,
    AgentStorage,
    openAgentSQLiteDatabase,
} from "../../sources/index.js";
import { inMemoryStorageLock, user } from "./fixtures.js";

/** Reopening creates a new database connection, Agent Base, provider session, and SDK process. */
export async function openClaudeRestartGym(
    ctx: Context,
    options: { databasePath: string; provider: BaseProvider; instructions: string; model: string },
) {
    const connection = await openAgentSQLiteDatabase(options.databasePath);
    const storage = new AgentStorage({
        acquireLock: inMemoryStorageLock(),
        database: connection.database,
    });
    const providers = new AgentProviders();
    providers.add("claude", options.provider, "claude");
    const events: SessionEvent[] = [];
    let agent: AgentBase;
    try {
        await storage.migrate(ctx, []);
        agent = await AgentBase.create(ctx, {
            id: "claude-cache-restart",
            providers,
            provider: "claude",
            model: options.model,
            effort: "high",
            persistence: storage.persistence("claude-cache-restart"),
            initialState: { instructions: options.instructions },
            hooks: { onEvent: (_eventCtx, event) => events.push(event) },
        });
    } catch (error) {
        await connection.close();
        throw error;
    }
    return {
        async ask(text: string): Promise<SessionEvent[]> {
            const start = events.length;
            await agent.send(ctx, user(text));
            await agent.waitForIdle();
            return events.slice(start);
        },
        async records() {
            return await storage.persistence(agent.id).load(ctx);
        },
        async close() {
            try {
                await agent.close();
            } finally {
                await connection.close();
            }
        },
    };
}
