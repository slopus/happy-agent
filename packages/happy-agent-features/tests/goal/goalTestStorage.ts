import type { AgentStorage } from "@slopus/happy-agent-base";

import { assertGoalPersistence, type GoalStorage } from "../../sources/goal/impl/goalStore.js";

/** Adapt Agent Base's broad class-backed store to Goal's narrow closed contract. */
export function goalStorage(storage: AgentStorage): GoalStorage {
    return {
        persistence: (agentId) => {
            const persistence = storage.persistence(agentId);
            assertGoalPersistence(persistence);
            return persistence;
        },
    };
}
