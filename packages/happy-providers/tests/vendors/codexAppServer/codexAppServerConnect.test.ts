import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import type { AcpConnection } from "@/protocol/acp/AcpConnection.js";
import { codexAppServerConnect } from "@/vendors/codexAppServer/codexAppServerConnect.js";
import { codexCliAgent } from "@/vendors/foreignAgents/codexCliAgent.js";

const SERVER = fileURLToPath(new URL("./fixtures/scriptedAppServer.mjs", import.meta.url));

async function connect(
    updates: string[],
    onAccountUsage?: (usage: ProviderUsage) => void,
    requestPermission: acp.Client["requestPermission"] = async () => ({
        outcome: { outcome: "cancelled" },
    }),
    texts: string[] = [],
): Promise<AcpConnection> {
    const client = {
        requestPermission,
        sessionUpdate: async (params: acp.SessionNotification) => {
            // A slow client: the turn's end must still wait for this update.
            await new Promise((resolve) => setTimeout(resolve, 50));
            updates.push(params.update.sessionUpdate);
            const update = params.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                texts.push(update.content.text);
            }
        },
    } as acp.Client;
    return await codexAppServerConnect(
        { command: process.execPath, args: [SERVER] },
        onAccountUsage,
    )(mkdtempSync(join(tmpdir(), "codex-app-server-")), client);
}

describe("codexAppServerConnect", () => {
    it.each(["gpt-6-astra", "gpt-future-test-model"])(
        "sends selected Ultra and later max unchanged to Codex for %s",
        async (model) => {
            const texts: string[] = [];
            const connection = await connect([], undefined, undefined, texts);
            try {
                const { sessionId } = await connection.conn.newSession({
                    cwd: tmpdir(),
                    mcpServers: [],
                });
                for (const effort of ["ultra", "max"] as const) {
                    const options = codexCliAgent.profile.modelOptions!(
                        `codex-cli/${model}`,
                        effort,
                    );
                    for (const option of options) {
                        if (typeof option.value !== "string") {
                            throw new Error("Expected a string model configuration value.");
                        }
                        await connection.conn.setSessionConfigOption({
                            sessionId,
                            configId: option.configId,
                            value: option.value,
                        });
                    }
                    await connection.conn.prompt({
                        sessionId,
                        prompt: [{ type: "text", text: "params" }],
                    });
                }
                expect(texts.map((text) => JSON.parse(text))).toMatchObject([
                    { turnStart: { model, effort: "ultra" } },
                    { turnStart: { model, effort: "max" } },
                ]);
            } finally {
                connection.terminate();
            }
        },
    );

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

    it("asks Happy about a subagent's command and Happy tool call on its parent's session", async () => {
        const asks: acp.RequestPermissionRequest[] = [];
        const texts: string[] = [];
        const connection = await connect(
            [],
            undefined,
            async (params) => {
                asks.push(params);
                // The command for the rest of the session; the Happy tool refused.
                return {
                    outcome:
                        asks.length === 1
                            ? { outcome: "selected", optionId: "session" }
                            : { outcome: "selected", optionId: "decline" },
                };
            },
            texts,
        );
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "asks" }] });
        } finally {
            connection.terminate();
        }
        expect(asks.map((ask) => ask.sessionId)).toEqual(["t1", "t1"]);
        expect(asks[0]!.toolCall.title).toContain("echo hi > /outside/x.txt");
        expect(asks[0]!.options.map((option) => option.kind)).toEqual([
            "allow_once",
            "allow_always",
            "reject_once",
        ]);
        // Codex offers no session-wide allow for an MCP tool call through this request.
        expect(asks[1]!.options.map((option) => option.kind)).toEqual([
            "allow_once",
            "reject_once",
        ]);
        expect(asks[1]!.toolCall._meta).toEqual({
            "happy/bridgedCall": { name: "delete_artifact", arguments: { artifactId: "a1" } },
        });
        expect(JSON.parse(texts.join(""))).toEqual({
            command: { decision: "acceptForSession" },
            tool: { action: "decline" },
        });
    });

    it("lets the person decide in Workspace write and Codex's reviewer in Auto, without network, pre-approving only Happy's never-reviewed tools", async () => {
        const texts: string[] = [];
        const connection = await connect([], undefined, undefined, texts);
        let workspaceWrite: unknown;
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: "/work",
                mcpServers: [
                    { type: "http", name: "happy", url: "http://127.0.0.1:1/mcp", headers: [] },
                ],
                _meta: { "happy/approvedTools": ["list_projects"] },
            });
            await connection.conn.setSessionConfigOption({
                sessionId,
                configId: "mode",
                value: "workspace-write",
            });
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "params" }] });
            workspaceWrite = (JSON.parse(texts.join("")) as { turnStart: unknown }).turnStart;
            texts.length = 0;
            await connection.conn.setSessionConfigOption({
                sessionId,
                configId: "mode",
                value: "auto",
            });
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "params" }] });
        } finally {
            connection.terminate();
        }
        const { threadStart, turnStart } = JSON.parse(texts.join("")) as {
            threadStart: { config: unknown };
            turnStart: Record<string, unknown>;
        };
        expect(threadStart.config).toEqual({
            mcp_servers: {
                happy: {
                    url: "http://127.0.0.1:1/mcp",
                    http_headers: {},
                    default_tools_approval_mode: "auto",
                    tools: { list_projects: { approval_mode: "approve" } },
                },
            },
        });
        expect(workspaceWrite).toMatchObject({
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: ["/work"],
                networkAccess: false,
            },
        });
        // Auto is the same sandbox with Codex's own reviewer deciding instead of the person.
        expect(turnStart).toMatchObject({
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: ["/work"],
                networkAccess: false,
            },
        });
    });
});
