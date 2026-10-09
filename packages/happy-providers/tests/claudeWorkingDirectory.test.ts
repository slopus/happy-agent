import { testContext } from "./testContext.js";

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeProvider, type ClaudeProviderOptions } from "@/vendors/claude/ClaudeProvider.js";
import type { ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";

describe("Claude working directory", () => {
    let root: string;
    // Reached through a link, the way macOS reaches `/tmp` through `/private/tmp`. A junction
    // needs no extra privilege on Windows and is an ordinary symlink everywhere else.
    let linked: string;
    let cwd: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "happy-claude-cwd-"));
        await mkdir(join(root, "real"));
        linked = join(root, "linked");
        await symlink(join(root, "real"), linked, "junction");
        cwd = realpathSync.native(join(root, "real"));
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it("does not pass an agent working directory to Claude Code", async () => {
        const sdkOptions = await runClaudeQuery({}, [user("Hello.")]);

        expect(sdkOptions).not.toHaveProperty("cwd");
    });

    // Claude Code reads the directory it starts in, so a daemon started from `/` or a home folder
    // would have it walk other applications' data. The caller names a neutral folder instead.
    it("runs Claude Code in the configured directory", async () => {
        const sdkOptions = await runClaudeQuery({ cwd: linked }, [user("Hello.")]);

        expect(sdkOptions?.cwd).toBe(cwd);
    });

    it("replays the conversation from the directory the live query runs in", async () => {
        const sdkOptions = await runClaudeQuery({ cwd: linked }, [
            user("Hello."),
            { role: "assistant", content: [{ type: "text", text: "Hi." }] },
            user("Continue."),
        ]);
        const entries = await replayedEntries(sdkOptions);

        expect(sdkOptions?.cwd).toBe(cwd);
        expect(entries.length).toBeGreaterThan(0);
        expect(new Set(entries.map((entry) => entry.cwd))).toEqual(new Set([cwd]));
        // Claude Code renders this snapshot into the cached prefix; a different directory here
        // than in the live query would make a rebuilt session miss the prompt cache.
        expect(entries.find((entry) => entry.type === "attachment")?.attachment).toMatchObject({
            type: "environment",
            snapshot: { workingDirectory: cwd },
        });
    });
});

function user(text: string): SessionMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

async function runClaudeQuery(
    options: Pick<ClaudeProviderOptions, "cwd">,
    messages: SessionMessage[],
): Promise<Record<string, unknown> | undefined> {
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
    if (credential === null) throw new Error("Expected test credential.");
    let sdkOptions: Record<string, unknown> | undefined;
    const provider = new ClaudeProvider({
        ...options,
        credential,
        env: { PATH: process.env.PATH },
        model: "sonnet[1m]",
        query: ((parameters: { options?: Record<string, unknown> }) => {
            sdkOptions = parameters.options;
            async function* results() {
                yield {
                    type: "result",
                    subtype: "success",
                    result: "OK",
                    session_id: "working-directory-session",
                    uuid: "working-directory-result",
                };
            }
            return Object.assign(results(), { close: () => {} });
        }) as unknown as ClaudeSdkQuery,
    });
    const session = await provider.session("working-directory-session", {
        instructions: "",
        tools: [],
    });

    try {
        for await (const _event of session.run(testContext, {
            context: { instructions: "", messages },
        })) {
            // Drain the stream so the query options are observable.
        }
    } finally {
        session.destroy();
    }
    return sdkOptions;
}

/** Loads the transcript Claude Code would resume from, exactly as the SDK asks for it. */
async function replayedEntries(
    sdkOptions: Record<string, unknown> | undefined,
): Promise<SessionStoreEntry[]> {
    const store = sdkOptions?.sessionStore as SessionStore | undefined;
    const sessionId = sdkOptions?.resume;
    if (store === undefined || typeof sessionId !== "string") {
        throw new Error("Expected the Claude query to resume a replayed session.");
    }
    return (await store.load({ projectKey: "project", sessionId })) ?? [];
}
