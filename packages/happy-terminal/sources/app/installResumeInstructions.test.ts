import { describe, expect, it, vi } from "vitest";

import { installResumeInstructions } from "./installResumeInstructions.js";

function createProcessEvents() {
    const listeners = new Set<() => void>();
    return {
        listeners,
        off: vi.fn((_event: "exit", listener: () => void) => {
            listeners.delete(listener);
        }),
        on: vi.fn((_event: "exit", listener: () => void) => {
            listeners.add(listener);
        }),
    };
}

describe("installResumeInstructions", () => {
    it("reports the session on the ordinary exit path", () => {
        const processEvents = createProcessEvents();
        const write = vi.fn();

        const instructions = installResumeInstructions({
            processEvents,
            resumeCommand: "happy-terminal resume abc123",
            sessionId: "abc123",
            write,
        });
        instructions.report();

        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]?.[0]).toContain("Agent: abc123");
        expect(write.mock.calls[0]?.[0]).toContain("Resume: happy-terminal resume abc123");
        expect(processEvents.listeners).toHaveLength(0);
    });

    it("reports the session when the process exits without shutting down", () => {
        const processEvents = createProcessEvents();
        const write = vi.fn();

        installResumeInstructions({
            processEvents,
            resumeCommand: "happy-terminal resume abc123",
            sessionId: "abc123",
            write,
        });
        for (const listener of processEvents.listeners) listener();

        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]?.[0]).toContain("Resume: happy-terminal resume abc123");
    });

    it("reports once when shutdown is followed by process exit", () => {
        const processEvents = createProcessEvents();
        const write = vi.fn();

        const instructions = installResumeInstructions({
            processEvents,
            resumeCommand: "happy-terminal resume abc123",
            sessionId: "abc123",
            write,
        });
        instructions.report();
        for (const listener of processEvents.listeners) listener();

        expect(write).toHaveBeenCalledTimes(1);
    });

    it("stays silent for a reload that reopens the same session", () => {
        const processEvents = createProcessEvents();
        const write = vi.fn();

        const instructions = installResumeInstructions({
            processEvents,
            resumeCommand: "happy-terminal resume abc123",
            sessionId: "abc123",
            write,
        });
        instructions.suppress();
        for (const listener of processEvents.listeners) listener();

        expect(write).not.toHaveBeenCalled();
        expect(processEvents.listeners).toHaveLength(0);
    });
});
