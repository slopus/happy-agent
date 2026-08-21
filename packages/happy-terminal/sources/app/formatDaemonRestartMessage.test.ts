import { describe, expect, it } from "vitest";

import { formatDaemonRestartMessage } from "./formatDaemonRestartMessage.js";

describe("formatDaemonRestartMessage", () => {
    it("describes production version changes", () => {
        expect(
            formatDaemonRestartMessage({
                currentIdentity: { version: "1.3.0" },
                runningIdentity: { version: "1.2.0" },
            }),
        ).toBe(
            "The running daemon uses Happy Terminal 1.2.0, but this CLI is Happy Terminal 1.3.0. Restart the daemon to use this CLI.",
        );
    });
});
