import { describe, expect, it } from "vitest";

import type { CleanupItem } from "../../sources/cleanup/CleanupSearch.js";
import { formatCleanupItem } from "../../sources/cleanup/impl/formatCleanupItem.js";

const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const AT = Date.UTC(2026, 10, 13);

function item(overrides: Partial<CleanupItem>): CleanupItem {
    return {
        kind: "task",
        id: "task1",
        name: "Refund flow",
        status: "active",
        createdAt: AT,
        lastActivityAt: AT,
        running: false,
        agents: 1,
        ...overrides,
    };
}

describe("cleanup rows", () => {
    it("mention each item by a share link saying what an agent is", () => {
        expect(formatCleanupItem(item({ agentId: "agent1" }), AT, INSTANCE)).toContain(
            `mention it as [](https://link.happy.page/#1/${INSTANCE}/agents/agent1?as=task)`,
        );
        expect(
            formatCleanupItem(
                item({ kind: "subtask", id: "agent2", agentId: "agent2" }),
                AT,
                INSTANCE,
            ),
        ).toContain(`(https://link.happy.page/#1/${INSTANCE}/agents/agent2?as=subtask)`);
        expect(
            formatCleanupItem(item({ kind: "workspace", id: "ws1", name: "Retry" }), AT, INSTANCE),
        ).toContain(`mention it as [](https://link.happy.page/#1/${INSTANCE}/workspaces/ws1)`);
    });

    it("mention each item by its happy:// link without an instance", () => {
        expect(formatCleanupItem(item({ agentId: "agent1" }), AT, undefined)).toContain(
            "mention it as [](happy://agents/agent1)",
        );
    });
});
