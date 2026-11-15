import {
    mkdir,
    mkdtemp,
    realpath,
    rm,
    appendFile,
    symlink,
    truncate,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKCompactBoundaryMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
    ClaudeNativeCompactionPendingError,
    readClaudeNativeCompaction,
} from "@/vendors/claudeAgent/impl/readClaudeNativeCompaction.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const BOUNDARY = "22222222-2222-4222-8222-222222222222";
const SUMMARY = "33333333-3333-4333-8333-333333333333";
const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

const boundary: SDKCompactBoundaryMessage = {
    type: "system",
    subtype: "compact_boundary",
    uuid: BOUNDARY,
    session_id: SESSION,
    compact_metadata: {
        trigger: "auto",
        pre_tokens: 730_473,
        post_tokens: 12_219,
    },
};

function message(
    uuid: string,
    parentUuid: string | null,
    type: "user" | "assistant",
    content: unknown,
): SessionStoreEntry {
    return {
        type,
        uuid,
        parentUuid,
        sessionId: SESSION,
        message: { role: type, content },
    };
}

function records(metadata: Record<string, unknown> = {}): SessionStoreEntry[] {
    return [
        message("old", null, "user", "SUPERSEDED HISTORY"),
        message("tail-user", "old", "user", "preserved user text"),
        message("tail-assistant", "tail-user", "assistant", [
            { type: "text", text: "preserved assistant text" },
        ]),
        {
            type: "system",
            subtype: "compact_boundary",
            uuid: BOUNDARY,
            parentUuid: null,
            sessionId: SESSION,
            compactMetadata: {
                trigger: "auto",
                preTokens: 730_473,
                postTokens: 12_219,
                ...metadata,
            },
        },
        {
            ...message(
                SUMMARY,
                BOUNDARY,
                "user",
                "EXACT native summary\nwith preserved whitespace\n",
            ),
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
        },
        // The native process can write its next response before the reader finishes. It must
        // remain a subsequent streamed response, not also appear inside the checkpoint.
        message("later-output", "tail-assistant", "assistant", [
            { type: "text", text: "LATER OUTPUT" },
        ]),
    ];
}

async function fixture(entries = records(), custom?: string) {
    const base = await mkdtemp(join(tmpdir(), "native-compaction-"));
    directories.push(base);
    const cwd = join(base, "workspace");
    const configDir = join(base, "account");
    await mkdir(cwd);
    const project = custom ?? (await realpath(cwd)).replace(/[^a-zA-Z0-9]/g, "-");
    const folder = join(configDir, "projects", project);
    await mkdir(folder, { recursive: true });
    const filename = join(folder, `${SESSION}.jsonl`);
    await writeFile(filename, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return {
        cwd,
        configDir,
        filename,
        ...(custom === undefined ? {} : { projectDirectoryName: custom }),
    };
}

async function read(input: Awaited<ReturnType<typeof fixture>>) {
    return await readClaudeNativeCompaction({
        ...input,
        sessionId: SESSION,
        boundary,
    });
}

describe("native Claude checkpoint extraction", () => {
    it.each([
        {
            preservedMessages: {
                anchorUuid: SUMMARY,
                uuids: ["tail-user", "tail-assistant"],
            },
        },
        {
            preservedSegment: {
                anchorUuid: SUMMARY,
                headUuid: "tail-user",
                tailUuid: "tail-assistant",
            },
        },
    ])("uses the SDK's preserved-tail reconstruction for %j", async (metadata) => {
        const result = await read(await fixture(records(metadata)));
        expect(result).toMatchObject({
            boundaryId: BOUNDARY,
            summaryId: SUMMARY,
            preTokens: 730_473,
            postTokens: 12_219,
            summary: "EXACT native summary\nwith preserved whitespace\n",
        });
        expect(result.messages.map((entry) => entry.uuid)).toEqual([
            SUMMARY,
            "tail-user",
            "tail-assistant",
        ]);
        expect(result.messages[1]?.message).toEqual({
            role: "user",
            content: "preserved user text",
        });
        expect(result.messages[2]?.message).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "preserved assistant text" }],
        });
        expect(JSON.stringify(result)).not.toContain("SUPERSEDED HISTORY");
        expect(JSON.stringify(result)).not.toContain("LATER OUTPUT");
    });

    it("keeps concurrent accounts and process environment independent", async () => {
        const first = await fixture();
        const secondRows = records();
        secondRows[4] = {
            ...secondRows[4]!,
            message: { role: "user", content: "second account summary" },
        };
        const second = await fixture(secondRows);
        const oldEnvironment = process.env.CLAUDE_CONFIG_DIR;
        const [left, right] = await Promise.all([read(first), read(second)]);
        expect(left.summary).toBe("EXACT native summary\nwith preserved whitespace\n");
        expect(right.summary).toBe("second account summary");
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(oldEnvironment);
    });

    it("honors an explicitly configured native project directory", async () => {
        expect(
            (await read(await fixture(records(), "explicit-project"))).messages.map(
                (entry) => entry.uuid,
            ),
        ).toEqual([SUMMARY]);
    });

    it("rejects a missing preserved message instead of returning a partial checkpoint", async () => {
        const input = await fixture(
            records({
                preservedMessages: { anchorUuid: SUMMARY, uuids: ["missing"] },
            }),
        );
        await expect(read(input)).rejects.toThrow("missing preserved messages");
    });

    it("preserves metadata caveats and tool results without mutating the native transcript", async () => {
        const rows = records({
            preservedMessages: {
                anchorUuid: SUMMARY,
                uuids: ["tail-user", "tail-assistant", "meta-result"],
            },
        });
        rows[2] = message("tail-assistant", "tail-user", "assistant", [
            {
                type: "tool_use",
                id: "retained-call",
                name: "Read",
                input: { file_path: "fixture" },
            },
        ]);
        rows.splice(3, 0, {
            ...message("meta-result", "tail-assistant", "user", [
                { type: "tool_result", tool_use_id: "retained-call", content: "retained result" },
                {
                    type: "text",
                    text: "<local-command-caveat>Command output</local-command-caveat>",
                },
            ]),
            isMeta: true,
        });
        const before = structuredClone(rows);
        const result = await read(await fixture(rows));
        expect(result.messages.map((message) => message.uuid)).toEqual([
            SUMMARY,
            "tail-user",
            "tail-assistant",
            "meta-result",
        ]);
        expect(result.messages.at(-1)).toMatchObject({ isMeta: true });
        expect(rows).toEqual(before);
    });

    it("reads a completed checkpoint while a later record is being appended", async () => {
        const input = await fixture();
        await appendFile(input.filename, '{"type":"assistant","message":');
        expect((await read(input)).summaryId).toBe(SUMMARY);
    });

    it("rejects duplicate preserved identities", async () => {
        const input = await fixture(
            records({
                preservedMessages: {
                    anchorUuid: SUMMARY,
                    uuids: ["tail-user", "tail-user"],
                },
            }),
        );
        await expect(read(input)).rejects.toThrow("invalid persisted checkpoint metadata");
    });

    it("classifies missing native file, boundary and summary as transient persistence waits", async () => {
        const missingFile = await fixture();
        await rm(missingFile.filename);
        await expect(read(missingFile)).rejects.toBeInstanceOf(ClaudeNativeCompactionPendingError);
        const missingBoundary = await fixture(records().slice(0, 3));
        await expect(read(missingBoundary)).rejects.toBeInstanceOf(
            ClaudeNativeCompactionPendingError,
        );
        const missingSummary = await fixture(records().slice(0, 4));
        await expect(read(missingSummary)).rejects.toBeInstanceOf(
            ClaudeNativeCompactionPendingError,
        );
        await appendFile(missingSummary.filename, '{"type":"user","isCompactSummary":');
        await expect(read(missingSummary)).rejects.toBeInstanceOf(
            ClaudeNativeCompactionPendingError,
        );
    });

    it("does not classify a completely persisted malformed summary as transient", async () => {
        const rows = records();
        rows[4] = { ...rows[4]!, message: { role: "user", content: "" } };
        const error = await read(await fixture(rows)).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ClaudeNativeCompactionPendingError);
    });

    it("rejects a missing summary and never substitutes older history", async () => {
        const input = await fixture(records().slice(0, 4));
        await expect(read(input)).rejects.toThrow("no complete persisted summary");
    });

    it("does not take a later boundary's summary for the requested boundary", async () => {
        const rows = records();
        rows.splice(4, 0, {
            type: "system",
            subtype: "compact_boundary",
            uuid: "later-boundary",
            sessionId: SESSION,
        });
        await expect(read(await fixture(rows))).rejects.toThrow("no complete persisted summary");
    });

    it("rejects an unfinished append and malformed JSON without exposing transcript text", async () => {
        const input = await fixture();
        await writeFile(input.filename, '{"type":"user","secret":"must not leak"');
        await expect(read(input)).rejects.toThrow("not fully persisted");
        await writeFile(input.filename, "must-not-leak\n");
        await expect(read(input)).rejects.toThrow("invalid entry");
    });

    it("fails on an oversized transcript instead of trimming history", async () => {
        const input = await fixture();
        await truncate(input.filename, 64 * 1024 * 1024 + 1);
        await expect(read(input)).rejects.toThrow("exceeds the reader's bound");
    });

    it("rejects a transcript symlink outside the selected account", async () => {
        const input = await fixture();
        const other = await fixture();
        await rm(input.filename);
        await symlink(other.filename, input.filename);
        await expect(read(input)).rejects.toThrow("outside its account directory");
    });

    it("rejects invalid identities and unsafe custom folder names", async () => {
        const input = await fixture();
        await expect(
            readClaudeNativeCompaction({
                ...input,
                sessionId: "../other",
                boundary,
            }),
        ).rejects.toThrow("invalid native compaction boundary");
        await expect(
            readClaudeNativeCompaction({
                ...input,
                sessionId: SESSION,
                boundary,
                projectDirectoryName: "../other",
            }),
        ).rejects.toThrow("invalid project directory name");
    });
});
