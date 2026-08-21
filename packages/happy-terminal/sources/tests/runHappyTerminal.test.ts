import { beforeEach, describe, expect, it, vi } from "vitest";

import { runApp } from "../app/runApp.js";
import { runHappyTerminal } from "../index.js";

vi.mock("../app/runApp.js", () => ({ runApp: vi.fn() }));

describe("the embedded Happy Terminal entry point", () => {
    beforeEach(() => {
        vi.mocked(runApp).mockReset();
    });

    it("runs on the host process and resolves without exiting it", async () => {
        vi.mocked(runApp).mockResolvedValue({ action: "exit" });

        await runHappyTerminal({ cwd: "/workspace" });

        expect(runApp).toHaveBeenCalledOnce();
        const options = vi.mocked(runApp).mock.calls[0]?.[1];
        expect(options).toMatchObject({ commandName: "happy", cwd: "/workspace" });
        expect(options?.onError).toBeTypeOf("function");
    });

    it("uses the embedding host's command in terminal instructions", async () => {
        vi.mocked(runApp).mockResolvedValue({ action: "exit" });

        await runHappyTerminal({
            commandName: "my-app agent",
            cwd: "/workspace",
            version: "2.4.0",
        });

        expect(vi.mocked(runApp).mock.calls[0]?.[1]).toMatchObject({
            commandName: "my-app agent",
            cwd: "/workspace",
            version: "2.4.0",
        });
    });

    it("reopens the same agent after an in-terminal reload", async () => {
        const onError = vi.fn();
        vi.mocked(runApp)
            .mockResolvedValueOnce({ action: "reload", sessionId: "agent-1" })
            .mockResolvedValueOnce({ action: "exit" });

        await runHappyTerminal({ cwd: "/workspace", onError });

        expect(vi.mocked(runApp).mock.calls[1]?.[1]).toMatchObject({
            cwd: "/workspace",
            onError,
            resumeSessionId: "agent-1",
        });
    });
});
