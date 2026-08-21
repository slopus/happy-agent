import { describe, expect, it, vi } from "vitest";

import { stripAnsi } from "./testing/stripAnsi.js";
import { createBackgroundTerminalViewer } from "./createBackgroundTerminalViewer.js";

describe("createBackgroundTerminalViewer", () => {
    it("fills the screen, follows output, and scrolls by page", () => {
        const requestRender = vi.fn();
        const viewer = createBackgroundTerminalViewer({
            command: "long command",
            cwd: "/workspace",
            height: () => 12,
            onCancel: vi.fn(),
            onRequestRender: requestRender,
            onStop: async () => undefined,
        });
        viewer.update({
            command: "long command",
            cwd: "/workspace",
            exitCode: null,
            sessionId: 4,
            status: "running",
            stderr: "",
            stderrDelta: "",
            stdout: Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n"),
            stdoutDelta: "",
            timedOut: false,
        });

        const bottom = stripAnsi(viewer.render(50).join("\n"));
        expect(bottom).toContain("Background terminal  Running");
        expect(bottom).toContain("line-20");
        expect(bottom).not.toContain("line-1\n");
        expect(viewer.render(50)).toHaveLength(12);

        viewer.handleInput?.("\x1b[5~");
        const earlier = stripAnsi(viewer.render(50).join("\n"));
        expect(earlier).toContain("line-8");
        expect(earlier).not.toContain("line-20");
        expect(requestRender).toHaveBeenCalledOnce();
    });
});
