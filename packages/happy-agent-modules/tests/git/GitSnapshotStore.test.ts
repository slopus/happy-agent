import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitSnapshotStore } from "../../sources/git/impl/GitSnapshotStore.js";
import type { GitChangeState } from "../../sources/git/types.js";

const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function storePath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-git-snapshots-"));
    roots.push(root);
    return join(root, "agent", "git-snapshots.json");
}

function state(overrides: Partial<GitChangeState> = {}): GitChangeState {
    return {
        base: "a".repeat(40),
        baseRef: "refs/remotes/origin/main",
        changedFiles: 1,
        comparison: "ready",
        conflicted: false,
        countsExact: true,
        deletions: 0,
        facts: { ahead: 0, behind: 0, branch: "main", detached: false, head: "a".repeat(40) },
        files: [
            {
                binary: false,
                insertions: 1,
                path: "src/main.ts",
                staged: false,
                status: "modified",
                unstaged: true,
            },
        ],
        filesTruncated: false,
        insertions: 1,
        scannedAt: 1,
        ...overrides,
    };
}

const entity = { path: "/work/repo", projectId: "project-1", workspaceId: "workspace-1" };

describe("GitSnapshotStore", () => {
    it("brings the last state of each repository back after a restart", async () => {
        const path = await storePath();
        const store = new GitSnapshotStore(path);
        await store.load();
        store.remember("workspace:workspace-1", entity, state(), "fingerprint-1");
        await store.dispose();

        const restarted = new GitSnapshotStore(path);
        await restarted.load();
        expect(restarted.get("workspace:workspace-1")).toMatchObject({
            entity,
            fingerprint: "fingerprint-1",
            partial: false,
            state: state(),
        });
    });

    it("keeps no binary contents and marks such a state partial", async () => {
        const path = await storePath();
        const store = new GitSnapshotStore(path);
        const binary = state({
            files: [
                {
                    binary: true,
                    newBytes: new Uint8Array([1, 2, 3]),
                    path: "image.png",
                    staged: false,
                    status: "added",
                    unstaged: true,
                },
            ],
        });
        store.remember("workspace:workspace-1", entity, binary, "fingerprint-1");
        await store.dispose();

        expect(await readFile(path, "utf8")).not.toContain("newBytes");
        const restarted = new GitSnapshotStore(path);
        await restarted.load();
        const entry = restarted.get("workspace:workspace-1");
        expect(entry?.partial).toBe(true);
        expect(entry?.state.files[0]?.newBytes).toBeUndefined();
    });

    it("treats an unreadable or foreign file as nothing remembered", async () => {
        const path = await storePath();
        const store = new GitSnapshotStore(path);
        store.remember("workspace:workspace-1", entity, state(), undefined);
        await store.dispose();
        await writeFile(path, JSON.stringify({ entries: [], version: 2 }));
        const foreign = new GitSnapshotStore(path);
        await foreign.load();
        expect(foreign.get("workspace:workspace-1")).toBeUndefined();

        await writeFile(path, "{ not json");
        const broken = new GitSnapshotStore(path);
        await broken.load();
        expect(broken.get("workspace:workspace-1")).toBeUndefined();
    });

    it("remembers only the most recently scanned repositories", async () => {
        const path = await storePath();
        const store = new GitSnapshotStore(path);
        for (let index = 0; index < 70; index += 1) {
            store.remember(`workspace:${String(index)}`, entity, state(), undefined);
        }
        await store.dispose();
        const restarted = new GitSnapshotStore(path);
        await restarted.load();
        expect(restarted.get("workspace:0")).toBeUndefined();
        expect(restarted.get("workspace:5")).toBeUndefined();
        expect(restarted.get("workspace:6")).toBeDefined();
        expect(restarted.get("workspace:69")).toBeDefined();
    });
});
