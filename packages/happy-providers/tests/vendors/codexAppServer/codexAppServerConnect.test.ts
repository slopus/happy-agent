import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import type { AcpConnection } from "@/protocol/acp/AcpConnection.js";
import { codexAppServerConnect } from "@/vendors/codexAppServer/codexAppServerConnect.js";

const SERVER = fileURLToPath(new URL("./fixtures/scriptedAppServer.mjs", import.meta.url));

async function connect(
    updates: string[],
    onAccountUsage?: (usage: ProviderUsage) => void,
): Promise<AcpConnection> {
    const client = {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async (params: acp.SessionNotification) => {
            // A slow client: the turn's end must still wait for this update.
            await new Promise((resolve) => setTimeout(resolve, 50));
            updates.push(params.update.sessionUpdate);
        },
    } as acp.Client;
    return await codexAppServerConnect(
        { command: process.execPath, args: [SERVER] },
        onAccountUsage,
    )(mkdtempSync(join(tmpdir(), "codex-app-server-")), client);
}

describe("codexAppServerConnect", () => {
    it("ends a turn only after the updates Codex sent before it", async () => {
        const updates: string[] = [];
        const connection = await connect(updates);
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            const response = await connection.conn.prompt({
                sessionId,
                prompt: [{ type: "text", text: "hello" }],
            });
            expect(response.stopReason).toBe("end_turn");
            expect(updates).toEqual(["agent_message_chunk"]);
        } finally {
            connection.terminate();
        }
    });

    it("reports a failed turn as an error instead of an empty answer", async () => {
        const connection = await connect([]);
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await expect(
                connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "fail" }] }),
            ).rejects.toThrow("429");
        } finally {
            connection.terminate();
        }
    });

    it("passes on the account limits Codex reports outside any thread", async () => {
        const usages: ProviderUsage[] = [];
        const connection = await connect([], (usage) => usages.push(usage));
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "limits" }] });
        } finally {
            connection.terminate();
        }
        expect(usages).toMatchObject([
            {
                providerId: "codex",
                windows: {
                    fiveHour: { usedPercent: 42, resetsAt: 1793791365_000 },
                    weekly: null,
                },
            },
        ]);
    });
});
