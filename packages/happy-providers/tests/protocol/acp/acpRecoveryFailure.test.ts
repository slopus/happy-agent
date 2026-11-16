import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import {
    assertAcpRecoveryAllowed,
    clearAcpRecoveryFailure,
    recordAcpRecoveryFailure,
} from "@/protocol/acp/impl/acpRecoveryFailure.js";

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});
const request: SessionRunRequest = {
    model: "claude-code/default",
    context: {
        instructions: "private instructions",
        messages: [
            { role: "user", content: [{ type: "text", text: "private task" }] },
            { role: "assistant", content: [{ type: "text", text: "private work" }] },
        ],
    },
};
const failure = Object.assign(new Error("No progress"), { code: "context_compaction_no_progress" });
async function directory() {
    const value = await mkdtemp(join(tmpdir(), "acp-recovery-"));
    directories.push(value);
    return value;
}

describe("durable unsuccessful recovery", () => {
    it("blocks Continue and compatible account switches sharing the failed history", async () => {
        const shared = await directory();
        await recordAcpRecoveryFailure(shared, "agent", request, [], failure);
        const continued: SessionRunRequest = {
            ...request,
            context: {
                ...request.context,
                messages: [
                    ...request.context.messages,
                    {
                        role: "system",
                        content: [{ type: "text", text: "Previous request failed" }],
                    },
                    { role: "user", content: [{ type: "text", text: "Continue" }] },
                ],
            },
        };
        // A newly constructed account/session reads the same durable hash, not a process cache.
        await expect(
            assertAcpRecoveryAllowed(shared, "agent", continued, []),
        ).rejects.toMatchObject({
            code: "context_recovery_blocked",
            message: expect.stringContaining("unchanged history"),
        });
        await expect(
            assertAcpRecoveryAllowed(shared, "other-agent", continued, []),
        ).resolves.toBeUndefined();
        const stored = await readFile(join(shared, "agent.json"), "utf8");
        expect(stored).not.toContain("private");
        expect(stored).not.toContain("No progress");
    });

    it("allows reduced/replaced context, changed tools or model, and explicit compact", async () => {
        const shared = await directory();
        await recordAcpRecoveryFailure(shared, "agent", request, [], failure);
        await expect(
            assertAcpRecoveryAllowed(
                shared,
                "agent",
                { ...request, context: { ...request.context, messages: [] } },
                [],
            ),
        ).resolves.toBeUndefined();
        await expect(
            assertAcpRecoveryAllowed(shared, "agent", { ...request, model: "larger-model" }, []),
        ).resolves.toBeUndefined();
        await expect(
            assertAcpRecoveryAllowed(
                shared,
                "agent",
                { ...request, context: { ...request.context, instructions: "smaller" } },
                [],
            ),
        ).resolves.toBeUndefined();
        await expect(
            assertAcpRecoveryAllowed(shared, "agent", request, [{ name: "changed" }]),
        ).resolves.toBeUndefined();
        await clearAcpRecoveryFailure(shared, "agent");
        await expect(
            assertAcpRecoveryAllowed(shared, "agent", request, []),
        ).resolves.toBeUndefined();
    });

    it("does not block unrelated failures and does not ignore unreadable recovery state", async () => {
        const shared = await directory();
        await recordAcpRecoveryFailure(shared, "agent", request, [], new Error("network"));
        await expect(
            assertAcpRecoveryAllowed(shared, "agent", request, []),
        ).resolves.toBeUndefined();
        await writeFile(join(shared, "agent.json"), "{}");
        await expect(assertAcpRecoveryAllowed(shared, "agent", request, [])).rejects.toThrow(
            "invalid",
        );
    });
});
