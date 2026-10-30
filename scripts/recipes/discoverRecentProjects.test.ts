import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
    new URL("../../docs/recipe/discover-recent-projects.ts", import.meta.url),
);

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "recent-projects-"));
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const project = join(root, "project with spaces");
    mkdirSync(project);
    const run = (args = ["--claude-home", claude, "--codex-home", codex], environment = {}) => {
        const result = spawnSync(process.execPath, [helper, ...args], {
            encoding: "utf8",
            timeout: 10_000,
            env: {
                ...process.env,
                HOME: root,
                USERPROFILE: root,
                CLAUDE_CONFIG_DIR: "",
                CODEX_HOME: "",
                ...environment,
            },
        });
        assert.equal(result.error, undefined);
        return result;
    };
    return { root, claude, codex, project, run };
}

test(
    "an inaccessible metadata home is not a complete empty scan",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    () => {
        const f = fixture();
        const privateRoot = join(f.root, "private");
        const hiddenHome = join(privateRoot, "claude");
        mkdirSync(join(hiddenHome, "projects"), { recursive: true });
        chmodSync(privateRoot, 0);
        try {
            const result = f.run(["--claude-home", hiddenHome, "--codex-home", f.codex]);
            assert.equal(result.status, 0, result.stderr);
            const output = JSON.parse(result.stdout);
            assert.deepEqual(output.projects, []);
            assert.equal(output.partial, true);
            assert.equal(output.sources[0].status, "unavailable");
        } finally {
            chmodSync(privateRoot, 0o700);
            rmSync(f.root, { recursive: true, force: true });
        }
    },
);

test("missing explicit metadata homes are reported without inventing an access failure", () => {
    const f = fixture();
    try {
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.projects, []);
        assert.equal(output.partial, false);
        assert.deepEqual(
            output.sources.map((source: { status: string }) => source.status),
            ["missing", "missing"],
        );
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test(
    "a skipped symlink home is not reported as fully scanned",
    { skip: process.platform === "win32" },
    () => {
        const f = fixture();
        try {
            const target = join(f.root, "target");
            mkdirSync(target);
            symlinkSync(target, f.claude, "dir");
            const result = f.run();
            assert.equal(result.status, 0, result.stderr);
            const output = JSON.parse(result.stdout);
            assert.equal(output.partial, true);
            assert.equal(output.sources[0].status, "skipped");
        } finally {
            rmSync(f.root, { recursive: true, force: true });
        }
    },
);

test("a redirected HOME is disclosed instead of claiming default history was checked", () => {
    const f = fixture();
    try {
        const result = f.run([]);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.partial, true);
        assert.equal(output.home.path, f.root);
        assert.equal(output.sources[0].path, join(f.root, ".claude", "projects"));
        assert.equal(output.sources[1].path, join(f.root, ".codex", "sessions"));
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("CLI overrides win over environment overrides and only cwd suggestions are returned", () => {
    const f = fixture();
    try {
        mkdirSync(join(f.claude, "projects", "encoded-project"), { recursive: true });
        mkdirSync(join(f.codex, "sessions", "2026", "10", "30"), { recursive: true });
        writeFileSync(
            join(f.claude, "projects", "encoded-project", "one.jsonl"),
            JSON.stringify({ cwd: f.project, message: "PRIVATE_CONVERSATION_SENTINEL" }) + "\n",
        );
        writeFileSync(
            join(f.codex, "sessions", "2026", "10", "30", "two.jsonl"),
            JSON.stringify({
                type: "session_meta",
                payload: { cwd: f.project, id: "PRIVATE_SESSION_SENTINEL" },
            }) + "\n",
        );
        const result = f.run(undefined, {
            CLAUDE_CONFIG_DIR: join(f.root, "wrong-claude"),
            CODEX_HOME: join(f.root, "wrong-codex"),
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.partial, false);
        assert.equal(output.projects.length, 1);
        assert.equal(output.projects[0].path, realpathSync(f.project));
        assert.deepEqual(
            output.sources.map((source: { status: string }) => source.status),
            ["scanned", "scanned"],
        );
        assert.doesNotMatch(result.stdout, /PRIVATE_/u);
        const fromEnvironment = f.run([], { CLAUDE_CONFIG_DIR: f.claude, CODEX_HOME: f.codex });
        assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
        assert.equal(JSON.parse(fromEnvironment.stdout).projects[0].path, realpathSync(f.project));
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("relative metadata overrides cannot silently search the working directory", () => {
    const f = fixture();
    try {
        const result = f.run(["--claude-home", ".claude", "--codex-home", f.codex]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /absolute path/u);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test(
    "unreadable history and unreadable project folders both make discovery partial",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    () => {
        const f = fixture();
        const history = join(f.claude, "projects");
        const privateProjects = join(f.root, "private-projects");
        const privateProject = join(privateProjects, "project");
        mkdirSync(history, { recursive: true });
        mkdirSync(privateProject, { recursive: true });
        try {
            chmodSync(history, 0);
            const unreadableHistory = f.run();
            assert.equal(unreadableHistory.status, 0, unreadableHistory.stderr);
            assert.equal(JSON.parse(unreadableHistory.stdout).partial, true);
            assert.equal(JSON.parse(unreadableHistory.stdout).sources[0].status, "unavailable");

            chmodSync(history, 0o700);
            writeFileSync(
                join(history, "one.jsonl"),
                JSON.stringify({ cwd: privateProject }) + "\n",
            );
            chmodSync(privateProjects, 0);
            const unreadableProject = f.run();
            assert.equal(unreadableProject.status, 0, unreadableProject.stderr);
            assert.deepEqual(JSON.parse(unreadableProject.stdout).projects, []);
            assert.equal(JSON.parse(unreadableProject.stdout).partial, true);
            assert.equal(JSON.parse(unreadableProject.stdout).sources[0].status, "partial");
        } finally {
            chmodSync(history, 0o700);
            chmodSync(privateProjects, 0o700);
            rmSync(f.root, { recursive: true, force: true });
        }
    },
);

test("malformed and stale location records do not hide a later valid suggestion", () => {
    const f = fixture();
    try {
        mkdirSync(join(f.claude, "projects"), { recursive: true });
        writeFileSync(
            join(f.claude, "projects", "one.jsonl"),
            [
                "malformed json",
                JSON.stringify({ message: "PRIVATE_CONVERSATION_SENTINEL" }),
                JSON.stringify({ cwd: join(f.root, "deleted-project") }),
                JSON.stringify({ cwd: f.project }),
                "",
            ].join("\n"),
        );
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.partial, false);
        assert.equal(output.projects[0].path, realpathSync(f.project));
        assert.doesNotMatch(result.stdout, /PRIVATE_/u);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
