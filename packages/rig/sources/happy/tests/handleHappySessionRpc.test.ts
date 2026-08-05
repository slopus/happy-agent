import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeAgentContext } from "../../agent/context/createNodeAgentContext.js";
import { NativeProcessManager } from "../../processes/index.js";
import { handleHappySessionRpc } from "../handleHappySessionRpc.js";
import { resolveHappyRipgrepExecutable } from "../resolveHappyRipgrepExecutable.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("handleHappySessionRpc", () => {
    it("lists a bounded directory page without invoking a shell", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-happy-rpc-"));
        directories.push(cwd);
        await mkdir(join(cwd, ".context"));
        await mkdir(join(cwd, ".git"));
        await writeFile(join(cwd, ".gitignore"), ".context/\n");
        await writeFile(join(cwd, "visible.txt"), "visible\n");
        const context = createNodeAgentContext({
            cwd,
            permissionMode: "read_only",
            processManager: new NativeProcessManager(),
        });
        const run = vi.fn(context.bash.run.bind(context.bash));
        context.bash.run = run;

        const result = (await handleHappySessionRpc({
            abort: async () => ({ aborted: true }),
            archive: () => ({ success: true }),
            answerQuestion: () => {},
            cancelQuestion: () => {},
            context: () => context,
            method: "listFileTree",
            params: { limit: 2, path: "" },
        })) as {
            entries: { name: string; type: string }[];
            nextCursor: string | null;
            success: boolean;
        };

        expect(result).toMatchObject({
            entries: [
                { name: ".context", type: "directory" },
                { name: ".gitignore", type: "file" },
            ],
            nextCursor: expect.any(String),
            success: true,
        });
        expect(run).not.toHaveBeenCalled();

        const changed = new Date(Date.now() + 10_000);
        await utimes(cwd, changed, changed);
        await expect(
            handleHappySessionRpc({
                abort: async () => ({ aborted: true }),
                archive: () => ({ success: true }),
                answerQuestion: () => {},
                cancelQuestion: () => {},
                context: () => context,
                method: "listFileTree",
                params: { cursor: result.nextCursor, limit: 2, path: "" },
            }),
        ).resolves.toMatchObject({
            reason: "directory_changed",
            success: false,
        });
    });

    it("runs Happy shell and file operations through Rig's permission-aware context", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-happy-rpc-"));
        directories.push(cwd);
        const context = createNodeAgentContext({
            cwd,
            permissionMode: "workspace_write",
            processManager: new NativeProcessManager(),
        });
        let abortCalls = 0;
        const answered: { answers: Record<string, unknown>; requestId: string }[] = [];
        const cancelled: string[] = [];
        const call = (method: string, params: unknown) =>
            handleHappySessionRpc({
                abort: async () => {
                    abortCalls += 1;
                    return { aborted: true };
                },
                archive: () => ({ success: true }),
                answerQuestion: (requestId, answers) => {
                    answered.push({ answers, requestId });
                },
                cancelQuestion: (requestId) => {
                    cancelled.push(requestId);
                },
                context: () => context,
                method,
                params,
            });

        await expect(resolveHappyRipgrepExecutable(context)).resolves.not.toBe("rg");
        await expect(call("abort", undefined)).resolves.toEqual({ aborted: true });
        expect(abortCalls).toBe(1);

        const written = await call("writeFile", {
            content: Buffer.from("hello").toString("base64"),
            expectedHash: null,
            path: "note.txt",
        });
        expect(written).toMatchObject({ success: true, hash: expect.any(String) });
        await expect(call("readFile", { path: "note.txt" })).resolves.toEqual({
            content: Buffer.from("hello").toString("base64"),
            success: true,
        });
        await expect(call("bash", { command: "printf mobile-shell" })).resolves.toMatchObject({
            exitCode: 0,
            stdout: "mobile-shell",
            success: true,
        });
        await expect(
            call("ripgrep", { args: ["--fixed-strings", "hello", "note.txt"] }),
        ).resolves.toMatchObject({
            exitCode: 0,
            stdout: "hello\n",
            success: true,
        });

        await expect(
            call("communication", {
                answers: { question_1: { options: ["Locally"] } },
                id: "call-1",
                kind: "form",
                status: "answered",
            }),
        ).resolves.toMatchObject({ success: true });
        expect(answered).toEqual([
            { answers: { question_1: { options: ["Locally"] } }, requestId: "call-1" },
        ]);

        await expect(
            call("communication", { id: "call-2", kind: "form", status: "cancelled" }),
        ).resolves.toMatchObject({ success: true });
        expect(cancelled).toEqual(["call-2"]);

        // A client that could not render the form dismisses it the same way.
        await expect(
            call("communication", { id: "call-3", kind: "diff", status: "cancelled" }),
        ).resolves.toMatchObject({ success: true });
        expect(cancelled).toEqual(["call-2", "call-3"]);

        await expect(
            call("communication", { id: "call-4", kind: "form", status: "answered" }),
        ).rejects.toThrow("Happy answered a question without any answers.");

        context.permissions?.setMode("read_only");
        await expect(
            call("writeFile", {
                content: Buffer.from("blocked").toString("base64"),
                expectedHash: (written as { hash: string }).hash,
                path: "note.txt",
            }),
        ).rejects.toThrow("File changes are disabled in read-only mode");
    });

    it("waits for a dismissed question to finish cancelling", async () => {
        let finishCancellation = () => {};
        let cancelled = false;
        const cancellation = new Promise<void>((resolve) => {
            finishCancellation = resolve;
        });
        const result = handleHappySessionRpc({
            abort: async () => ({ aborted: true }),
            archive: () => ({ success: true }),
            answerQuestion: () => {},
            cancelQuestion: async () => {
                await cancellation;
                cancelled = true;
            },
            context: () => {
                throw new Error("The communication RPC does not need an agent context.");
            },
            method: "communication",
            params: { id: "call-1", kind: "form", status: "cancelled" },
        });
        let settled = false;
        void result.then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);
        finishCancellation();
        await expect(result).resolves.toEqual({ success: true });
        expect(cancelled).toBe(true);
    });
});
