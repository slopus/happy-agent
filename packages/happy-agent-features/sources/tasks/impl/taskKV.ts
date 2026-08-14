import { AgentKV } from "@slopus/happy-agent-base";

import { assertTaskPersistence, type TaskStorage } from "../TaskStore.js";

/** The feature's per-agent KV scope, shared by public methods and agent hooks/tools. */
export function taskKV(storage: TaskStorage, agentId: string): AgentKV {
    const persistence = storage.persistence(agentId);
    assertTaskPersistence(persistence);
    return new AgentKV(persistence, `kv.${agentId}.`).scoped("feature", "tasks");
}
