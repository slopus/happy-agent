import { createRootContext, mapAsyncLock, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import type { ComputePermissions } from "../../../sources/compute/Compute.js";
import { computeToolVendor } from "../../../sources/compute/ComputeToolVendor.js";
import { FileReadLog } from "../../../sources/impl/FileReadLog.js";
import { listComputeDirectory } from "../../../sources/compute/impl/listComputeDirectory.js";
import { moveComputeFile } from "../../../sources/compute/impl/moveComputeFile.js";
import { readComputeCommand } from "../../../sources/compute/impl/readComputeCommand.js";
import { searchComputeFileContents } from "../../../sources/compute/impl/searchComputeFileContents.js";
import { startComputeCommand } from "../../../sources/compute/impl/startComputeCommand.js";
import { walkComputeFiles } from "../../../sources/compute/impl/walkComputeFiles.js";
import { writeComputeCommandInput } from "../../../sources/compute/impl/writeComputeCommandInput.js";
import { parseCodexPatch } from "../../../sources/impl/parseCodexPatch.js";
import { parseClaudeBashId } from "../../../sources/compute/tools/claude/impl/parseClaudeBashId.js";
import { parseGrokTaskId } from "../../../sources/compute/tools/grok/impl/parseGrokTaskId.js";
import { FakeCompute } from "../support/FakeCompute.js";

const ctx = createRootContext().named("happy-agent-modules-compute-contract-edge");
const permissions = {
    mode: "workspace_write",
    network: { egress: false, localBinding: false },
} as ComputePermissions;

class MemoryPersistence {
    readonly database = undefined as never;
    readonly values = new Map<string, unknown>();

    async transaction<Result>(
        transactionCtx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await work(transactionCtx);
    }
    async load(): Promise<readonly never[]> {
        return [];
    }
    async append(): Promise<void> {}
    async clearRecords(): Promise<void> {}
    async readValues(
        _ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value }));
    }
    async writeValue(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }
    async writeValueIfAbsent(_ctx: Context, key: string, value: unknown): Promise<boolean> {
        if (this.values.has(key)) return false;
        this.values.set(key, value);
        return true;
    }
    async deleteValue(_ctx: Context, key: string): Promise<void> {
        this.values.delete(key);
    }
}

function readLog(persistence: MemoryPersistence): FileReadLog {
    return new FileReadLog(
        new (class {
            readonly prefix = "agent.module.compute.";
            async read(readCtx: Context, key: string): Promise<unknown> {
                return await persistence
                    .readValues(readCtx, `${this.prefix}${key}`)
                    .then(
                        (entries) =>
                            entries.find((entry) => entry.key === `${this.prefix}${key}`)?.value,
                    );
            }
            async update(
                updateCtx: Context,
                key: string,
                updater: (current: unknown) => unknown,
            ): Promise<unknown> {
                const current = await this.read(updateCtx, key);
                const value = await updater(current);
                await persistence.writeValue(updateCtx, `${this.prefix}${key}`, value);
                return value;
            }
            async transaction<Result>(
                transactionCtx: Context,
                work: (kv: never, ctx: Context) => Promise<Result>,
            ): Promise<Result> {
                return await work(this as never, transactionCtx);
            }
        })() as never,
        mapAsyncLock<string>(),
        "agent-a",
    );
}

describe("compute implementation contracts", () => {
    it("selects a vendor from known model families and falls back safely", () => {
        expect(computeToolVendor({ model: "anthropic/opus-5" })).toBe("claude");
        expect(computeToolVendor({ model: "openai/gpt-5.6-sol" })).toBe("codex");
        expect(computeToolVendor({ model: "xai/grok-4.5" })).toBe("grok");
        expect(computeToolVendor({ model: "vendor/future-model", providerKind: "grok" })).toBe(
            "grok",
        );
        expect(computeToolVendor({ model: "vendor/future-model" })).toBe("codex");
        expect(computeToolVendor({ model: undefined, providerKind: "claude" })).toBe("claude");
        expect(() => computeToolVendor({ model: "" })).toThrow(/selection is invalid/);
    });

    it("accepts only plain positive decimal Claude shell IDs", () => {
        expect(parseClaudeBashId("1")).toBe(1);
        expect(parseClaudeBashId("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
        for (const value of [" 1 ", "1e2", "0x10", "+1", "1.0"]) {
            expect(() => parseClaudeBashId(value), value).toThrow(
                /not a background shell identifier/,
            );
        }
    });

    it("trims Grok task IDs but rejects zero and unsafe values", () => {
        expect(parseGrokTaskId(" 42 ")).toBe(42);
        for (const value of ["", "0", "-1", "1.5", "1e2", "9007199254740992"]) {
            expect(() => parseGrokTaskId(value), value).toThrow(/not a background command task ID/);
        }
    });

    it("returns a clear missing-command error from the shared command reader", async () => {
        const compute = new FakeCompute();

        await expect(
            readComputeCommand(compute, ctx, { commandId: 99, waitMs: 0 }),
        ).rejects.toThrow("There is no command 99");
    });

    it("rejects command input when the host shell cannot accept stdin", async () => {
        const compute = new FakeCompute();
        compute.shell.supportsSessionInput = false;

        await expect(
            writeComputeCommandInput(compute, ctx, {
                commandId: 1,
                input: "yes\n",
                waitMs: 0,
            }),
        ).rejects.toThrow("cannot be typed into");
    });

    it("does not leave a session behind when the host returns no startup snapshot", async () => {
        const compute = new FakeCompute();
        compute.script("bad-host", { keepRunning: true });
        let killed = 0;
        const originalKill = compute.shell.killSession;
        compute.shell.readSession = async () => undefined;
        compute.shell.killSession = async (sessionId) => {
            killed += 1;
            return await originalKill(sessionId);
        };

        await expect(
            startComputeCommand(compute, ctx, {
                command: "bad-host",
                waitMs: 0,
            }),
        ).rejects.toThrow("could not be started");
        expect(killed).toBe(1);
    });

    it("uses paged directory reads instead of materializing a full listing", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/src/main.ts", "main");
        compute.fs.readdir = async () => {
            throw new Error("unbounded directory read");
        };

        await expect(
            listComputeDirectory(compute, ctx, {
                path: "/workspace",
                maxEntries: 1,
            }),
        ).resolves.toMatchObject({
            entries: ["src/"],
            totalEntries: 1,
            truncated: false,
        });
    });

    it("uses paged directory reads while walking search trees", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/src/main.ts", "main");
        compute.fs.readdir = async () => {
            throw new Error("unbounded directory read");
        };

        await expect(
            walkComputeFiles(compute.fs, permissions, "/workspace"),
        ).resolves.toMatchObject({
            files: [{ path: "/workspace/src/main.ts" }],
            truncated: false,
        });
    });

    it("walks a root that is itself a file as that one file", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/src/main.ts", "main");

        await expect(
            walkComputeFiles(compute.fs, permissions, "/workspace/src/main.ts"),
        ).resolves.toMatchObject({
            files: [{ path: "/workspace/src/main.ts" }],
            truncated: false,
        });
    });

    it("searches a file named directly instead of reporting no matches", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/src/main.ts", "const needle = 1;\n");

        const found = await searchComputeFileContents(compute, ctx, {
            pattern: "needle",
            path: "/workspace/src/main.ts",
            outputMode: "content",
            limit: 10,
        });

        expect(found.matchedFiles).toBe(1);
        expect(found.matches).toEqual(["/workspace/src/main.ts:1: const needle = 1;"]);
    });

    it("supports multiline search when the tool explicitly requests it", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/example.ts", "first line\nsecond line\n");

        const found = await searchComputeFileContents(compute, ctx, {
            pattern: "first line\\nsecond line",
            multiline: true,
            outputMode: "files_with_matches",
            limit: 10,
        });

        expect(found.matchedFiles).toBe(1);
        expect(found.matchCount).toBeGreaterThan(0);
        expect(found.matches).toEqual(["/workspace/example.ts"]);
    });

    it("rejects malformed regular expressions before traversing the tree", async () => {
        const compute = new FakeCompute();

        await expect(
            searchComputeFileContents(compute, ctx, {
                pattern: "[",
                outputMode: "files_with_matches",
                limit: 10,
            }),
        ).rejects.toThrow(/not a valid regular expression/);
    });

    it("removes destination directories again when a move fails", async () => {
        const persistence = new MemoryPersistence();
        const reads = readLog(persistence);
        const compute = new FakeCompute();
        compute.write("/workspace/source.txt", "source\n");
        await reads.record(ctx, "/workspace/source.txt", 2_000);
        compute.moveFailure = new Error("move failed");

        await expect(
            moveComputeFile(compute, reads, ctx, {
                source: "/workspace/source.txt",
                destination: "/workspace/new/deep/destination.txt",
            }),
        ).rejects.toThrow("move failed");
        expect(compute.directories.has("/workspace/new")).toBe(false);
        expect(compute.directories.has("/workspace/new/deep")).toBe(false);
        expect(compute.files.has("/workspace/source.txt")).toBe(true);
    });

    it("rejects a patch with content after its end marker", () => {
        expect(() =>
            parseCodexPatch(
                [
                    "*** Begin Patch",
                    "*** Add File: note.txt",
                    "+hello",
                    "*** End Patch",
                    "trailing content",
                ].join("\n"),
            ),
        ).toThrow(/after the patch|last line|trailing/i);
    });
});
