import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const active = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...active].map(async (gym) => await gym.dispose()));
    active.clear();
});

const fixtures = {
    "README.md": "workspace readme\n",
    "src/Alpha.ts": "export const alpha = 1;\n",
    "src/beta.test.ts": "export const beta = 2;\n",
    "docs/notes.md": "notes for the matrix\n",
    "empty/zero.txt": "",
    "assets/data.bin": new Uint8Array([0, 1, 127, 128, 254, 255]),
} as const;

describe("files API matrix: search and tree", () => {
    it.each([
        ["F001", "README", ["README.md", "src/beta.test.ts"]],
        ["F002", "readme", ["README.md", "src/beta.test.ts"]],
        [
            "F003",
            ".TS",
            [
                "src/Alpha.ts",
                "src/beta.test.ts",
                "empty/zero.txt",
                "assets/data.bin",
                "docs/notes.md",
                "README.md",
            ],
        ],
        ["F004", "does-not-exist", []],
        [
            "F005",
            "a",
            [
                "README.md",
                "docs/notes.md",
                "src/Alpha.ts",
                "src/beta.test.ts",
                "assets/data.bin",
                "empty/zero.txt",
            ],
        ],
        ["F006", "notes", ["docs/notes.md", "src/beta.test.ts"]],
    ] as const)("%s searches filenames with its matching rule", async (id, query, expected) => {
        const gym = await fresh();
        const result = await gym.client.searchFiles(await root(gym), {
            limit: 50,
            query,
        });
        expect(result.files.map((file) => file.path)).toEqual(expected);
        expect(id).toMatch(/^F00[1-6]$/);
    });

    it("[F007] enforces the search limit while preserving order", async () => {
        const gym = await fresh();
        const result = await gym.client.searchFiles(await root(gym), { limit: 2, query: "a" });
        expect(result.files.map((file) => file.path)).toEqual(["README.md", "docs/notes.md"]);
    });

    it("[F008] returns the root tree in deterministic order", async () => {
        const gym = await fresh();
        const result = await gym.client.getFileTree(await root(gym), { limit: 50 });
        const paths = result.entries.map((entry) => entry.path);
        expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
        expect(paths).toEqual(expect.arrayContaining(["README.md", "docs", "empty", "src"]));
        expect(result.nextCursor).toBeNull();
    });

    it("[F009] lists one nested directory level with file metadata", async () => {
        const gym = await fresh();
        const result = await gym.client.getFileTree(await root(gym), { path: "src", limit: 50 });
        expect(result.entries.map((entry) => entry.name)).toEqual(["Alpha.ts", "beta.test.ts"]);
        expect(result.entries.every((entry) => entry.modified > 0)).toBe(true);
    });

    it("[F010] pages a tree with a numeric cursor", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        const first = await gym.client.getFileTree(workspaceId, { path: "src", limit: 1 });
        expect(first.entries).toHaveLength(1);
        expect(first.nextCursor).toBe("1");
        const second = await gym.client.getFileTree(workspaceId, {
            ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
            path: "src",
            limit: 1,
        });
        expect(second.entries).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
    });

    it("[F011] rejects a tree path that names a file", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(() => gym.client.getFileTree(workspaceId, { path: "README.md" }), 400);
    });

    it("[F012] rejects a missing tree path and serves a later valid request", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(() => gym.client.getFileTree(workspaceId, { path: "missing" }), 404);
        await expect(gym.client.readFile(workspaceId, "README.md")).resolves.toMatchObject({
            content: expect.any(String),
        });
    });
});

describe("files API matrix: bytes, hashes, and writes", () => {
    it.each([
        ["F013", "README.md", Buffer.from("workspace readme\n")],
        ["F014", "empty/zero.txt", Buffer.alloc(0)],
        ["F015", "src/Alpha.ts", Buffer.from("export const alpha = 1;\n")],
        ["F016", "assets/data.bin", Buffer.from([0, 1, 127, 128, 254, 255])],
    ] as const)("%s reads exact bytes and their sha256", async (_id, path, expected) => {
        const gym = await fresh();
        const response = await gym.client.readFile(await root(gym), path);
        expect(Buffer.from(response.content, "base64")).toEqual(expected);
        expect(response.hash).toBe(createHash("sha256").update(expected).digest("hex"));
    });

    it("[F017] creates a new file only with a null expected hash", async () => {
        const gym = await fresh();
        const response = await gym.client.writeFile(await root(gym), {
            content: Buffer.from("created\n").toString("base64"),
            expectedHash: null,
            path: "generated/created.txt",
        });
        await expect(
            gym.client.readFile(await root(gym), "generated/created.txt"),
        ).resolves.toMatchObject({
            hash: response.hash,
        });
    });

    it("[F018] updates an existing file using its current hash", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        const before = await gym.client.readFile(workspaceId, "README.md");
        const response = await gym.client.writeFile(workspaceId, {
            content: Buffer.from("updated\n").toString("base64"),
            expectedHash: before.hash,
            path: "README.md",
        });
        expect(response.hash).not.toBe(before.hash);
        await expect(gym.client.readFile(workspaceId, "README.md")).resolves.toMatchObject({
            hash: response.hash,
        });
    });

    it("[F019] returns the winner hash for a stale compare-and-swap", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        const before = await gym.client.readFile(workspaceId, "README.md");
        const winner = await gym.client.writeFile(workspaceId, {
            content: Buffer.from("winner\n").toString("base64"),
            expectedHash: before.hash,
            path: "README.md",
        });
        const error = await captureError(() =>
            gym.client.writeFile(workspaceId, {
                content: Buffer.from("loser\n").toString("base64"),
                expectedHash: before.hash,
                path: "README.md",
            }),
        );
        expect(error).toMatchObject({ code: "hash_mismatch", status: 409 });
        expect(error.body).toMatchObject({ hash: winner.hash });
    });

    it("[F020] does not create a file when a nonexistent path has a non-null guard", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(
            () =>
                gym.client.writeFile(workspaceId, {
                    content: Buffer.from("not created\n").toString("base64"),
                    expectedHash: "0".repeat(64),
                    path: "missing.txt",
                }),
            409,
        );
        await expectError(() => gym.client.readFile(workspaceId, "missing.txt"), 404);
    });

    it("[F021] serializes two writers that share one stale hash", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        const before = await gym.client.readFile(workspaceId, "README.md");
        const outcomes = await Promise.allSettled([
            gym.client.writeFile(workspaceId, {
                content: Buffer.from("left\n").toString("base64"),
                expectedHash: before.hash,
                path: "README.md",
            }),
            gym.client.writeFile(workspaceId, {
                content: Buffer.from("right\n").toString("base64"),
                expectedHash: before.hash,
                path: "README.md",
            }),
        ]);
        expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    });

    it("[F022] writes into an existing nested parent and exposes the new tree entry", async () => {
        const gym = await fresh();
        await mkdir(join(gym.workspacePath, "one/two"), { recursive: true });
        const workspaceId = await root(gym);
        await gym.client.writeFile(workspaceId, {
            content: Buffer.from("nested\n").toString("base64"),
            expectedHash: null,
            path: "one/two/three.txt",
        });
        await expect(
            gym.client.getFileTree(workspaceId, { path: "one/two" }),
        ).resolves.toMatchObject({
            entries: [expect.objectContaining({ path: "one/two/three.txt", type: "file" })],
        });
    });

    it("[F023] rejects malformed base64 without creating a file", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(
            () =>
                gym.client.writeFile(workspaceId, {
                    content: "not base64!",
                    expectedHash: null,
                    path: "bad.bin",
                }),
            400,
        );
        await expectError(() => gym.client.readFile(workspaceId, "bad.bin"), 404);
    });

    it("[F024] rejects a file over the public read-size limit", async () => {
        const gym = await fresh();
        await writeFile(
            join(gym.workspacePath, "oversized.bin"),
            Buffer.alloc(44 * 1024 * 1024 + 1),
        );
        const workspaceId = await root(gym);
        await expectError(() => gym.client.readFile(workspaceId, "oversized.bin"), 413);
    });
});

describe("files API matrix: confinement, races, and restart", () => {
    it("[F025] rejects parent traversal for reads and writes", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(() => gym.client.readFile(workspaceId, "../outside"), 400);
        await expectError(
            () =>
                gym.client.writeFile(workspaceId, {
                    content: Buffer.from("escape").toString("base64"),
                    expectedHash: null,
                    path: "../escape",
                }),
            400,
        );
    });

    it("[F026] rejects absolute paths while leaving a valid path usable", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(() => gym.client.readFile(workspaceId, "/etc/passwd"), 400);
        await expect(gym.client.readFile(workspaceId, "README.md")).resolves.toMatchObject({
            hash: expect.any(String),
        });
    });

    it("[F027] rejects a symlink that resolves outside the workspace", async () => {
        const gym = await fresh();
        const outside = join(dirname(gym.workspacePath), "secret.txt");
        await writeFile(outside, "secret\n", "utf8");
        await symlink(outside, join(gym.workspacePath, "escape.txt"));
        const workspaceId = await root(gym);
        await expectError(() => gym.client.readFile(workspaceId, "escape.txt"), 403);
    });

    it("[F028] rejects invalid cursor syntax without changing the tree", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(
            () => gym.client.getFileTree(workspaceId, { cursor: "01", limit: 1 }),
            400,
        );
        await expect(gym.client.getFileTree(workspaceId, { limit: 50 })).resolves.toMatchObject({
            entries: expect.any(Array),
        });
    });

    it("[F029] rejects a write through a symlinked parent", async () => {
        const gym = await fresh();
        const outside = join(dirname(gym.workspacePath), "outside-dir");
        await mkdir(outside, { recursive: true });
        await symlink(outside, join(gym.workspacePath, "linked"));
        const workspaceId = await root(gym);
        await expectError(
            () =>
                gym.client.writeFile(workspaceId, {
                    content: Buffer.from("escape").toString("base64"),
                    expectedHash: null,
                    path: "linked/file.txt",
                }),
            403,
        );
    });

    it("[F030] preserves bytes and hashes across a daemon restart", async () => {
        const gym = await fresh();
        await mkdir(join(gym.workspacePath, "durable"), { recursive: true });
        const workspaceId = await root(gym);
        const content = Buffer.from("durable\n").toString("base64");
        const response = await gym.client.writeFile(workspaceId, {
            content,
            expectedHash: null,
            path: "durable/file.txt",
        });
        await gym.restart();
        await expect(gym.client.readFile(workspaceId, "durable/file.txt")).resolves.toEqual({
            content,
            hash: response.hash,
        });
    });

    it("[F031] remains usable after a rejected read", async () => {
        const gym = await fresh();
        const workspaceId = await root(gym);
        await expectError(() => gym.client.readFile(workspaceId, "missing"), 404);
        await expect(gym.client.readFile(workspaceId, "README.md")).resolves.toMatchObject({
            content: expect.any(String),
        });
    });
});

async function fresh(): Promise<AgentGym> {
    const gym = await createAgentGym({ files: fixtures, timeoutMs: 20_000 });
    active.add(gym);
    return gym;
}

async function root(gym: AgentGym): Promise<string> {
    const projects = await gym.client.listProjects();
    const project = projects.projects.find(
        (candidate) =>
            candidate.compute.type === "host" && candidate.compute.path === gym.workspacePath,
    );
    if (project === undefined) throw new Error("The gym root project was not registered.");
    return project.id;
}

async function captureError(action: () => Promise<unknown>): Promise<{
    readonly body?: unknown;
    readonly code?: unknown;
    readonly status?: unknown;
}> {
    try {
        await action();
    } catch (error: unknown) {
        return error as {
            readonly body?: unknown;
            readonly code?: unknown;
            readonly status?: unknown;
        };
    }
    throw new Error("Expected the public request to fail.");
}

async function expectError(action: () => Promise<unknown>, status: number): Promise<void> {
    const error = await captureError(action);
    expect(error.status).toBe(status);
    expect(error.code).toBe(
        status === 409
            ? "hash_mismatch"
            : status === 413
              ? "too_large"
              : status === 404
                ? "not_found"
                : "invalid_request",
    );
}
