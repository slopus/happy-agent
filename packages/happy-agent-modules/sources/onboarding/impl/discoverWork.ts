import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ChatProviderId } from "./chatActions/chatAction.js";

const run = promisify(execFile);

/** At most this many projects, sessions read, and bytes of findings in all. */
const MAX_PROJECTS = 30;
const MAX_SESSIONS = 60;
const MAX_FINDINGS_BYTES = 16 * 1_024;
/** Only the start of a session is read: where it ran and what was asked first. */
const SESSION_HEAD_BYTES = 64 * 1_024;
const GIT_TIMEOUT_MS = 5_000;

interface Project {
    readonly path: string;
    readonly asked: string[];
    lastAt: number;
}

/**
 * What the person has been working on, read only from the places onboarding disclosed: the
 * connected assistant's own sessions (`~/.codex/sessions` or `~/.claude/projects`), where each
 * ran and the first thing asked, then the last 30 days of commit subjects and the recent branch
 * names of those projects. Nothing is written; Git runs with optional locks off. The findings are
 * bounded, newest projects first, and `undefined` when no session named a project.
 */
export async function discoverWork(
    home: string,
    assistant: ChatProviderId,
): Promise<string | undefined> {
    const root =
        assistant === "codex"
            ? join(home, ".codex", "sessions")
            : join(home, ".claude", "projects");
    const files = (await sessionFiles(root))
        .sort((left, right) => right.at - left.at)
        .slice(0, MAX_SESSIONS);
    const projects = new Map<string, Project>();
    for (const file of files) {
        const session = await readSession(file.path);
        if (session === undefined) continue;
        const project = projects.get(session.cwd) ?? { path: session.cwd, asked: [], lastAt: 0 };
        project.lastAt = Math.max(project.lastAt, file.at);
        if (session.asked !== undefined && project.asked.length < 4)
            project.asked.push(session.asked);
        projects.set(session.cwd, project);
    }
    const parts: string[] = [];
    let size = 0;
    for (const project of [...projects.values()]
        .sort((left, right) => right.lastAt - left.lastAt)
        .slice(0, MAX_PROJECTS)) {
        const part = [
            `## ${project.path}`,
            `Last session: ${new Date(project.lastAt).toISOString().slice(0, 10)}`,
            ...project.asked.map((asked) => `Asked: ${asked}`),
            ...(await gitHistory(project.path)),
        ].join("\n");
        if (size + part.length > MAX_FINDINGS_BYTES) break;
        parts.push(part);
        size += part.length;
    }
    return parts.length === 0
        ? undefined
        : `What the person has been working on, from their ${assistant === "codex" ? "Codex" : "Claude Code"} sessions and the Git history of those projects:\n\n${parts.join("\n\n")}`;
}

async function sessionFiles(
    root: string,
): Promise<{ readonly path: string; readonly at: number }[]> {
    const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
    const files = entries.filter((entry) => entry.endsWith(".jsonl")).slice(0, 5_000);
    const stats = await Promise.all(
        files.map(async (entry) => {
            const path = join(root, entry);
            const info = await stat(path).catch(() => undefined);
            return info?.isFile() === true ? { path, at: info.mtimeMs } : undefined;
        }),
    );
    return stats.filter((file) => file !== undefined);
}

/** Where a session ran and the first thing the person asked, from its first lines. */
async function readSession(
    path: string,
): Promise<{ readonly cwd: string; readonly asked?: string } | undefined> {
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) return undefined;
    let text: string;
    try {
        const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SESSION_HEAD_BYTES, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await handle.close();
    }
    let cwd: string | undefined;
    let asked: string | undefined;
    for (const line of text.split("\n")) {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            continue;
        }
        cwd ??= stringAt(value, ["cwd"]) ?? stringAt(value, ["payload", "cwd"]);
        asked ??= askedIn(value);
        if (cwd !== undefined && asked !== undefined) break;
    }
    if (cwd === undefined || !cwd.startsWith("/")) return undefined;
    return asked === undefined ? { cwd } : { cwd, asked };
}

/** The person's own words in one session line, from Claude Code's or Codex's format. */
function askedIn(value: unknown): string | undefined {
    const message = objectAt(value, ["message"]) ?? objectAt(value, ["payload"]);
    if (message === undefined || message["role"] !== "user") return undefined;
    const content = message["content"];
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                    .map((part: unknown) =>
                        typeof part === "object" && part !== null && "text" in part
                            ? String((part as { text: unknown }).text)
                            : "",
                    )
                    .join(" ")
              : "";
    const trimmed = text.replace(/\s+/gu, " ").trim();
    // Context the assistant injected, such as environment notes, is not what the person asked.
    if (trimmed === "" || trimmed.startsWith("<")) return undefined;
    return trimmed.length > 240 ? `${trimmed.slice(0, 239)}…` : trimmed;
}

async function gitHistory(path: string): Promise<string[]> {
    const git = async (args: readonly string[]) =>
        (
            await run("git", ["-C", path, ...args], {
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: 256 * 1_024,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
            }).catch(() => ({ stdout: "" }))
        ).stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    const [subjects, branches] = await Promise.all([
        git(["log", "--since=30.days", "--no-merges", "--format=%s", "-n", "40"]),
        git([
            "for-each-ref",
            "--sort=-committerdate",
            "--count=8",
            "--format=%(refname:short)",
            "refs/heads",
        ]),
    ]);
    return [
        ...(branches.length === 0 ? [] : [`Branches: ${branches.join(", ")}`]),
        ...subjects.map((subject) => `Commit: ${subject.slice(0, 160)}`),
    ];
}

function objectAt(value: unknown, path: readonly string[]): Record<string, unknown> | undefined {
    let current = value;
    for (const key of path) {
        if (typeof current !== "object" || current === null) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return typeof current === "object" && current !== null
        ? (current as Record<string, unknown>)
        : undefined;
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
    const found = objectAt(value, path.slice(0, -1))?.[path[path.length - 1]!];
    return typeof found === "string" ? found : undefined;
}
