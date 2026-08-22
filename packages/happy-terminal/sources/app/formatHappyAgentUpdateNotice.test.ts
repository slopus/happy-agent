import { describe, expect, it } from "vitest";

import { formatHappyAgentUpdateNotice } from "./formatHappyAgentUpdateNotice.js";

describe("formatHappyAgentUpdateNotice", () => {
    it("proposes the embedding host's upgrade command", () => {
        expect(
            formatHappyAgentUpdateNotice(
                { currentVersion: "1.2.3", latestVersion: "1.2.4" },
                "my-app agent",
            ),
        ).toEqual({
            text: "Happy Agent 1.2.4 is available; this terminal is using 1.2.3. Run 'my-app agent upgrade' to download it and restart Happy Agent.",
            title: "Happy Agent update available",
        });
    });
});
