import { createTestRootContext } from "../testing/createTestRootContext.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCodingAssistantAgent } from "../runtime/createCodingAssistantAgent.js";
import { modelOpenaiGpt56Sol } from "@slopus/rig-execution";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const CODEX_AUTH_PATH = path.join(homedir(), ".codex", "auth.json");

function hasLocalCodexAuth(): boolean {
    if (!existsSync(CODEX_AUTH_PATH)) return false;
    try {
        const data = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8")) as {
            tokens?: { access_token?: unknown };
        };
        return (
            typeof data.tokens?.access_token === "string" &&
            data.tokens.access_token.trim().length > 0
        );
    } catch {
        return false;
    }
}

const describeLive = LIVE && hasLocalCodexAuth() ? describe : describe.skip;
const ctx = createTestRootContext();

describeLive("configured Codex provider live", () => {
    it("sends priority inference without legacy model tools", async () => {
        const managed = {
            agentId: "live-agent",
            description: "Live probe",
            path: "/root/live_probe",
            sessionId: "live-subagent",
            status: "completed" as const,
            taskName: "live_probe",
        };
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: process.cwd(),
            modelId: modelOpenaiGpt56Sol.id,
            serviceTier: "fast",
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: async () => managed,
                interrupt: async () => managed,
                list: () => [managed],
                maxDepth: 3,
                spawn: async () => ({ ...managed, output: "ok" }),
                wait: async () => ({ agents: [managed], timedOut: false }),
            },
        });

        try {
            runtime.agent.enqueueUserMessage("Reply with exactly: live collaboration schema ok");
            const result = await runtime.agent.run(ctx);
            if (result.stopReason === "error") {
                throw new Error(result.errorMessage ?? "Codex inference failed.");
            }
        } finally {
            await runtime.agent.close();
        }
    }, 120_000);
});

describe.skipIf(!LIVE || hasLocalCodexAuth())(
    "configured Codex provider live prerequisites",
    () => {
        it("documents how to run the live test", () => {
            if (LIVE) {
                expect.fail(
                    "RIG_LIVE_TEST=1 is set but ~/.codex/auth.json is missing a usable access_token",
                );
            }
        });
    },
);
