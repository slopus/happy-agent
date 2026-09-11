import { expect, it } from "vitest";
import { GitModule, type GitChangeSnapshot } from "../../sources/git/index.js";

function snapshot(): GitChangeSnapshot {
    return {
        generation: "generation",
        version: 1,
        facts: { ahead: 1, behind: 0, branch: "feature", detached: false, head: "b".repeat(40) },
        base: "a".repeat(40),
        comparison: "ready",
        changedFiles: 1,
        countsExact: true,
        conflicted: false,
        deletions: 2,
        insertions: 3,
        filesTruncated: false,
        scannedAt: 123,
        files: [
            {
                path: "new.txt",
                previousPath: "old.txt",
                status: "renamed",
                staged: true,
                unstaged: false,
                binary: false,
                insertions: 3,
                deletions: 2,
                oldBytes: Buffer.from("old"),
                newBytes: Buffer.from("new"),
                contentToken: "private-token",
            },
        ],
    };
}

it("matches the public HTTP Git projection without exposing private content", () => {
    const source = snapshot();
    const response = new GitModule().resource(source);
    expect(response).toEqual({
        facts: { ...source.facts, upstream: null },
        comparison: "ready",
        base: source.base,
        changedFiles: 1,
        countsExact: true,
        conflicted: false,
        deletions: 2,
        insertions: 3,
        filesTruncated: false,
        scannedAt: 123,
        files: [
            {
                path: "new.txt",
                previousPath: "old.txt",
                status: "renamed",
                staged: true,
                unstaged: false,
                binary: false,
                insertions: 3,
                deletions: 2,
            },
        ],
    });
    expect(JSON.stringify(response)).not.toContain("private-token");
});

it("preserves complete shared state without applying a transport-specific limit", () => {
    const source = snapshot();
    source.files = Array.from({ length: 1000 }, (_, i) => ({
        ...source.files[0]!,
        path: `${i}/${"界".repeat(1024)}`,
    }));
    source.changedFiles = 1000;
    const response = new GitModule().resource(source);
    expect(response).toMatchObject({
        changedFiles: 1000,
        countsExact: true,
        insertions: 3,
        deletions: 2,
        filesTruncated: false,
    });
    expect(response.files).toHaveLength(1000);
    expect(source.files).toHaveLength(1000);
    expect(response.files.map((file) => file.path)).toEqual(source.files.map((file) => file.path));
});

it("does not turn an unavailable comparison into a clean one", () => {
    const source = snapshot();
    source.comparison = "unavailable";
    delete source.base;
    source.files = [];
    source.countsExact = false;
    expect(new GitModule().resource(source)).toMatchObject({
        comparison: "unavailable",
        base: null,
        countsExact: false,
    });
});
