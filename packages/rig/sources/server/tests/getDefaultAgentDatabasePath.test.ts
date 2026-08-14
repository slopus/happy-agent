import { describe, expect, it } from "vitest";

import { getDefaultAgentDatabasePath } from "../getDefaultAgentDatabasePath.js";

describe("getDefaultAgentDatabasePath", () => {
    it("uses an agent-only directory outside RIG_HOME", () => {
        expect(
            getDefaultAgentDatabasePath(
                {
                    RIG_HOME: "/home/tester/rig-home",
                },
                "/home/tester",
            ),
        ).toBe("/home/tester/.happy/agent/sessions.sqlite");
    });

    it("supports an explicit agent home", () => {
        expect(
            getDefaultAgentDatabasePath(
                {
                    RIG_AGENT_HOME: "/var/lib/rig-agents",
                },
                "/home/tester",
            ),
        ).toBe("/var/lib/rig-agents/sessions.sqlite");
    });
});
