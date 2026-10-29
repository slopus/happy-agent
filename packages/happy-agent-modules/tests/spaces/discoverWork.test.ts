import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWork } from "../../sources/spaces/impl/discoverWork.js";

const folders: string[] = [];

afterEach(async () => {
    await Promise.all(
        folders.splice(0).map(async (folder) => await rm(folder, { force: true, recursive: true })),
    );
});

async function home(): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "discover-work-"));
    folders.push(folder);
    return folder;
}

function jsonl(lines: readonly object[]): string {
    return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("discoverWork", () => {
    it("reads where Claude Code sessions ran and the first thing asked, skipping injected context", async () => {
        const root = await home();
        const project = join(root, "work", "billing");
        await mkdir(project, { recursive: true });
        const sessions = join(root, ".claude", "projects", "-work-billing");
        await mkdir(sessions, { recursive: true });
        await writeFile(
            join(sessions, "one.jsonl"),
            jsonl([
                { type: "user", cwd: project, message: { role: "user", content: "<command>x" } },
                {
                    type: "user",
                    cwd: project,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "Fix   the invoice\nexport" }],
                    },
                },
            ]),
        );
        const findings = await discoverWork(root, "claude");
        expect(findings).toContain("from their Claude Code sessions");
        expect(findings).toContain(`## ${project}`);
        expect(findings).toContain("Asked: Fix the invoice export");
        expect(findings).not.toContain("<command>");
    });

    it("reads only the assistant's own sessions, and finds nothing without them", async () => {
        const root = await home();
        await mkdir(join(root, ".claude", "projects", "a"), { recursive: true });
        await writeFile(
            join(root, ".claude", "projects", "a", "one.jsonl"),
            jsonl([{ cwd: "/work/a", message: { role: "user", content: "Hello" } }]),
        );
        expect(await discoverWork(root, "codex")).toBeUndefined();
        // A session without an absolute working folder names no project.
        await mkdir(join(root, ".codex", "sessions"), { recursive: true });
        await writeFile(
            join(root, ".codex", "sessions", "one.jsonl"),
            jsonl([{ payload: { cwd: "relative" } }]),
        );
        expect(await discoverWork(root, "codex")).toBeUndefined();
    });
});
