import { lstatSync } from "node:fs";
import { release, type as osType, version as osVersion } from "node:os";
import { dirname, join } from "node:path";

/**
 * The attachments Claude Code 2.1.280 records after the first prompt of a session.
 *
 * On its first prompt the CLI persists an environment snapshot, the model identity, an empty
 * session context, and the calendar date, and it renders them into one system message placed
 * directly after the first user turn. On resume it renders whatever the transcript already holds
 * in that same position and appends an update at the end only when the stored value differs from
 * what it computes now. A rebuilt session therefore reproduces the live request, and keeps its
 * prompt-cache prefix, only when its transcript carries attachments equal to the ones the CLI
 * would have written itself. This module computes those values the way the CLI does.
 */
export type ClaudeSessionAttachment =
    | {
          type: "environment";
          snapshot: {
              workingDirectory: string;
              isWorktree: boolean;
              isGitRepo: boolean;
              additionalWorkingDirectories: string[];
              platform: string;
              shell: string;
              osVersion: string;
          };
      }
    | {
          type: "model";
          identity: {
              modelId: string;
              marketingName: string | null;
              knowledgeCutoff: string | null;
          };
          text: string;
      }
    | { type: "session_context"; context: Record<string, never> }
    | { type: "date"; date: string };

/** Claude Code's own catalog entries for the models Rig serves, as the CLI renders them. */
const CLAUDE_MODEL_IDENTITIES: Readonly<
    Record<string, { displayName: string; knowledgeCutoff: string; oneMillionSuffix: boolean }>
> = {
    "claude-fable-5-1": {
        displayName: "Fable 5.1",
        knowledgeCutoff: "June 2026",
        oneMillionSuffix: false,
    },
    "claude-fable-5": {
        displayName: "Fable 5",
        knowledgeCutoff: "January 2026",
        oneMillionSuffix: false,
    },
    "claude-opus-5-5": {
        displayName: "Opus 5.5",
        knowledgeCutoff: "June 2026",
        oneMillionSuffix: true,
    },
    "claude-opus-5": { displayName: "Opus 5", knowledgeCutoff: "May 2026", oneMillionSuffix: true },
    "claude-opus-4-8": {
        displayName: "Opus 4.8",
        knowledgeCutoff: "January 2026",
        oneMillionSuffix: true,
    },
    "claude-sonnet-5": {
        displayName: "Sonnet 5",
        knowledgeCutoff: "January 2026",
        oneMillionSuffix: false,
    },
};

export function claudeSessionAttachments(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    model: string;
    now?: Date;
}): ClaudeSessionAttachment[] {
    const git = detectGitRepository(options.cwd);
    const identity = claudeModelIdentity(options.model);
    return [
        {
            type: "environment",
            snapshot: {
                workingDirectory: options.cwd,
                isWorktree: git.isWorktree,
                isGitRepo: git.isGitRepo,
                additionalWorkingDirectories: [],
                platform: process.platform,
                shell: shellDescription(options.env),
                osVersion:
                    process.platform === "win32"
                        ? `${osVersion()} ${release()}`
                        : `${osType()} ${release()}`,
            },
        },
        { type: "model", identity, text: modelIdentityText(identity) },
        { type: "session_context", context: {} },
        { type: "date", date: calendarDate(options.now ?? new Date()) },
    ];
}

export function claudeModelIdentity(model: string): {
    modelId: string;
    marketingName: string | null;
    knowledgeCutoff: string | null;
} {
    const oneMillion = model.toLowerCase().includes("[1m]");
    const base = model.replace(/\[1m\]$/i, "");
    const known = CLAUDE_MODEL_IDENTITIES[base];
    if (known === undefined) return { modelId: model, marketingName: null, knowledgeCutoff: null };
    return {
        modelId: model,
        marketingName:
            oneMillion && known.oneMillionSuffix
                ? `${known.displayName} (1M context)`
                : known.displayName,
        knowledgeCutoff: known.knowledgeCutoff,
    };
}

function modelIdentityText(identity: ReturnType<typeof claudeModelIdentity>): string {
    const named =
        identity.marketingName === null
            ? `You are powered by the model ${identity.modelId}.`
            : `You are powered by the model named ${identity.marketingName}. The exact model ID is ${identity.modelId}.`;
    return identity.knowledgeCutoff === null
        ? named
        : `${named} Assistant knowledge cutoff is ${identity.knowledgeCutoff}.`;
}

/** Claude Code names zsh and bash, passes any other `SHELL` through, and says "unknown" for none. */
function shellDescription(env: NodeJS.ProcessEnv): string {
    if (process.platform === "win32") return "PowerShell";
    const shell = env.SHELL || "unknown";
    if (shell.includes("zsh")) return "zsh";
    if (shell.includes("bash")) return "bash";
    return shell;
}

/**
 * The nearest ancestor holding a `.git` entry makes the directory a repository. A `.git` file
 * points at a git directory elsewhere, which is how Claude Code recognizes a worktree; a symlinked
 * `.git` counts as no repository at all, exactly as the CLI treats it.
 */
function detectGitRepository(cwd: string): { isGitRepo: boolean; isWorktree: boolean } {
    let directory = cwd;
    for (;;) {
        try {
            const entry = lstatSync(join(directory, ".git"));
            if (entry.isSymbolicLink()) return { isGitRepo: false, isWorktree: false };
            if (entry.isDirectory()) return { isGitRepo: true, isWorktree: false };
            if (entry.isFile()) return { isGitRepo: true, isWorktree: true };
        } catch {
            // No `.git` here; keep walking up.
        }
        const parent = dirname(directory);
        if (parent === directory) return { isGitRepo: false, isWorktree: false };
        directory = parent;
    }
}

function calendarDate(now: Date): string {
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
}
