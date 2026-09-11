import { createHash } from "node:crypto";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { getHappyDaemonPaths, happyAgentBinaryPath } from "./getHappyDaemonPaths.js";

describe.skipIf(process.platform !== "win32")("native Windows daemon paths", () => {
    it("uses the same named pipe identity as the Happy Agent daemon", () => {
        const paths = getHappyDaemonPaths({ HAPPY_HOME_DIR: "C:\\fixtures\\Happy Home" });
        const identity = createHash("sha256")
            .update(win32.resolve(paths.agentDirectory).toLowerCase())
            .digest("hex");
        expect(paths.socketPath).toBe(`\\\\.\\pipe\\happy-agent-${identity}`);
    });

    it("resolves the installed Windows executable", () => {
        const paths = getHappyDaemonPaths({ HAPPY_HOME_DIR: "C:\\fixtures\\Happy Home" });
        expect(happyAgentBinaryPath(paths, "0.4.48")).toBe(
            join(paths.versionsDirectory, "0.4.48", "happy-agent.exe"),
        );
    });
});
