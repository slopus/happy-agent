import { AgentKV, type AgentPersistence } from "@slopus/happy-agent-base";
import { createRootContext, mapAsyncLock, withLifetime, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { boundOutputText } from "../../../sources/compute/impl/boundOutputText.js";
import { canonicalComputePath } from "../../../sources/compute/impl/canonicalComputePath.js";
import { shouldReviewComputePath } from "../../../sources/compute/impl/shouldReviewComputePath.js";
import { FileReadLog } from "../../../sources/impl/FileReadLog.js";
import {
    isPathInside,
    joinComputePath,
    parentComputePath,
    relativeComputePath,
    resolveComputePath,
    basenameComputePath,
} from "../../../sources/compute/impl/resolveComputePath.js";
import { globToRegExp } from "../../../sources/compute/impl/globToRegExp.js";
import {
    isGitIgnored,
    loadInitialGitIgnoreScopes,
    readGitIgnoreScope,
} from "../../../sources/compute/impl/gitIgnore.js";
import { searchComputeFileContents } from "../../../sources/compute/impl/searchComputeFileContents.js";
import { walkComputeFiles } from "../../../sources/compute/impl/walkComputeFiles.js";
import type { ComputePermissions } from "../../../sources/compute/Compute.js";

const ctx = createRootContext().named("happy-agent-modules-compute-impl-edge");
const permissions = {
    mode: "workspace_write",
    network: { egress: false, localBinding: false },
} as ComputePermissions;

class MemoryPersistence implements AgentPersistence {
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

function readLogFor(
    persistence: MemoryPersistence,
    agentId = "agent-a",
): { readonly log: FileReadLog; readonly kv: AgentKV } {
    const kv = new AgentKV(persistence, "agent.").scoped("module", "compute");
    return {
        kv,
        log: new FileReadLog(kv, mapAsyncLock<string>(), agentId),
    };
}

describe("compute implementation boundaries", () => {
    it("bounds output without changing exact-budget text", () => {
        expect(boundOutputText("abc", { maxCharacters: 3 })).toEqual({
            text: "abc",
            truncated: false,
            omittedCharacters: 0,
        });
        expect(boundOutputText("abcdef", { maxCharacters: 3 })).toEqual({
            text: "abc\n[Output was truncated: 3 further characters are not shown.]",
            truncated: true,
            omittedCharacters: 3,
        });
        expect(boundOutputText("abcdef", { maxCharacters: 3, keep: "tail" })).toEqual({
            text: "[Earlier output was truncated: 3 characters are not shown.]\ndef",
            truncated: true,
            omittedCharacters: 3,
        });
    });

    it("keeps the returned text within a zero-character budget", () => {
        const bounded = boundOutputText("output", { maxCharacters: 0 });

        expect(bounded.truncated).toBe(true);
        expect(bounded.text.length).toBeLessThanOrEqual(0);
    });

    it("normalizes machine paths without using the host platform", () => {
        expect(resolveComputePath("../src/./main.ts", "/workspace/project")).toBe(
            "/workspace/src/main.ts",
        );
        expect(resolveComputePath("~/notes/../todo.md", "/workspace", "/Users/agent")).toBe(
            "/Users/agent/todo.md",
        );
        expect(resolveComputePath("C:\\work\\..\\repo\\file.ts", "C:\\ignored")).toBe(
            "C:\\repo\\file.ts",
        );
        expect(joinComputePath("/workspace/project/", "../README.md")).toBe("/workspace/README.md");
        expect(parentComputePath("/")).toBe("/");
        expect(parentComputePath("relative")).toBe("relative");
        expect(basenameComputePath("/workspace/src/main.ts")).toBe("main.ts");
        expect(relativeComputePath("/workspace", "/workspace/src/main.ts")).toBe("src/main.ts");
        expect(relativeComputePath("/workspace", "/outside/main.ts")).toBe("/outside/main.ts");
        expect(isPathInside("/workspace", "/workspace/src")).toBe(true);
        expect(isPathInside("/workspace", "/workspace-other/src")).toBe(false);
        expect(() => resolveComputePath("~", "/workspace")).toThrow("has no home directory");
    });

    it("resolves a missing child through an existing symlinked parent", async () => {
        const compute = new FakeCompute();
        compute.directories.add("/outside");
        compute.links.set("/workspace/link", "/outside");

        await expect(
            canonicalComputePath(compute.fs, permissions, "/workspace/link/new.txt"),
        ).resolves.toBe("/outside/new.txt");
    });

    it("reviews paths when canonical resolution fails instead of assuming they are safe", async () => {
        const compute = new FakeCompute();
        compute.fs.realpath = async () => {
            throw new Error("canonical path unavailable");
        };

        await expect(
            shouldReviewComputePath(compute, "new.txt", { write: false }, ctx),
        ).resolves.toBe(true);
    });

    it("matches glob literals, alternatives, and segment boundaries", () => {
        expect(globToRegExp("src/**/*.ts").test("src/main.ts")).toBe(true);
        expect(globToRegExp("src/**/*.ts").test("src/lib/main.ts")).toBe(true);
        expect(globToRegExp("src/*.ts").test("src/lib/main.ts")).toBe(false);
        expect(globToRegExp("*.{ts,tsx}").test("main.ts")).toBe(true);
        expect(globToRegExp("*.{ts,tsx}").test("main.js")).toBe(false);
        expect(globToRegExp("file[1].ts").test("file[1].ts")).toBe(true);
        expect(globToRegExp("file[1].ts").test("file1.ts")).toBe(false);
        expect(globToRegExp("README", { ignoreCase: true }).test("readme")).toBe(true);
    });

    it("allows a file with no valid remembered read and records later reads", async () => {
        const persistence = new MemoryPersistence();
        const { log, kv } = readLogFor(persistence);
        const compute = new FakeCompute();
        compute.write("/workspace/app.ts", "export const app = 1;\n");
        await kv.write(ctx, "reads", { invalid: true });

        await expect(
            log.assertRead(ctx, compute.fs, permissions, "/workspace/app.ts"),
        ).resolves.toBeUndefined();
        await log.record(ctx, "/workspace/app.ts", 2_000);
        await expect(
            log.assertRead(ctx, compute.fs, permissions, "/workspace/app.ts"),
        ).resolves.toBeUndefined();
    });

    it("keeps only the newest read entry for a path and caps the log", async () => {
        const persistence = new MemoryPersistence();
        const { log } = readLogFor(persistence);

        for (let index = 0; index < 513; index += 1) {
            await log.record(ctx, `/workspace/file-${String(index)}.ts`, index);
        }
        await log.record(ctx, "/workspace/file-512.ts", 999);

        const stored = persistence.values.get("agent.module.compute.reads") as
            | readonly { readonly path: string; readonly mtimeMs: number }[]
            | undefined;
        expect(stored).toHaveLength(512);
        expect(stored?.[0]?.path).toBe("/workspace/file-1.ts");
        expect(stored?.at(-1)).toEqual({
            path: "/workspace/file-512.ts",
            mtimeMs: 999,
        });
    });

    it("rejects a file changed to an older mtime instead of allowing stale overwrite", async () => {
        const persistence = new MemoryPersistence();
        const { log } = readLogFor(persistence);
        const compute = new FakeCompute();
        compute.write("/workspace/app.ts", "before\n");
        const stat = await compute.fs.stat(permissions, "/workspace/app.ts");
        await log.record(ctx, "/workspace/app.ts", stat.mtimeMs);
        await compute.fs.writeFile(permissions, "/workspace/app.ts", "after\n");
        await compute.fs.setModificationTime(permissions, "/workspace/app.ts", stat.mtimeMs - 1);

        await expect(
            log.assertRead(ctx, compute.fs, permissions, "/workspace/app.ts"),
        ).rejects.toThrow(/changed since it was last read/);
    });

    it("applies nested gitignore scopes and skips git metadata and symlinks", async () => {
        const compute = new FakeCompute();
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/.git/config", "secret");
        compute.write("/workspace/.gitignore", "dist/\n*.log\n!important.log\n");
        compute.write("/workspace/dist/ignored.ts", "ignored");
        compute.write("/workspace/debug.log", "ignored");
        compute.write("/workspace/important.log", "kept");
        compute.write("/workspace/src/main.ts", "kept");
        compute.links.set("/workspace/src/link.ts", "/workspace/src/main.ts");

        const walked = await walkComputeFiles(compute.fs, permissions, "/workspace", {
            respectGitIgnore: true,
        });

        expect(walked.truncated).toBe(false);
        expect(walked.files.map((file) => file.path)).toEqual([
            "/workspace/.gitignore",
            "/workspace/important.log",
            "/workspace/src/main.ts",
        ]);
    });

    it("parses gitignore comments, escaped hashes, directory rules, and negation", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/.gitignore", "# comment\n\\#literal\ncache/\n*.tmp\n!keep.tmp\n");
        const scope = await readGitIgnoreScope(compute.fs, permissions, "/workspace");
        expect(scope).toBeDefined();
        expect(isGitIgnored("/workspace/#literal", false, scope ? [scope] : [])).toBe(true);
        expect(isGitIgnored("/workspace/cache", true, scope ? [scope] : [])).toBe(true);
        expect(isGitIgnored("/workspace/cache/file.txt", false, scope ? [scope] : [])).toBe(false);
        expect(isGitIgnored("/workspace/drop.tmp", false, scope ? [scope] : [])).toBe(true);
        expect(isGitIgnored("/workspace/keep.tmp", false, scope ? [scope] : [])).toBe(false);
    });

    it("loads ancestor ignore scopes for an external search root only through its git root", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/outside");
        compute.directories.add("/outside/project");
        compute.directories.add("/outside/project/src");
        compute.write("/outside/project/.gitignore", "ignored.txt\n");
        compute.directories.add("/outside/project/.git");

        const scopes = await loadInitialGitIgnoreScopes(
            compute.fs,
            permissions,
            "/outside/project/src",
        );

        expect(scopes.map((scope) => scope.directory)).toEqual(["/outside/project"]);
    });

    it("aborts a search through the context lifetime", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/file.ts", "needle\n");
        const controller = new AbortController();
        controller.abort();
        const aborted = withLifetime(ctx, controller.signal);

        await expect(
            searchComputeFileContents(compute, aborted, {
                pattern: "needle",
                outputMode: "files_with_matches",
                limit: 10,
            }),
        ).rejects.toThrow("Search aborted.");
        expect(aborted.lifetime?.aborted).toBe(true);
    });
});
