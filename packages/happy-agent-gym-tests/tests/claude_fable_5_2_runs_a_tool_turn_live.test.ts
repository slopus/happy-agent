import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Fable 5.2 through the real daemon and the real Claude provider: one turn that runs a shell
 * command and answers with its output and the model's own name. Opt in with a Claude login in
 * HAPPY_FABLE_LIVE_OAUTH_TOKEN; the account's plan must include Fable.
 */
const TURN_MS = 240_000;
const token = process.env.HAPPY_FABLE_LIVE_OAUTH_TOKEN;
const fable = { providerId: "live_claude", modelId: "anthropic/fable-5-2", effort: "low" };

interface Block {
    readonly type: string;
    readonly text?: string;
    readonly name?: string;
}

function agentBlocks(history: GymAgentHistory): Block[] {
    return history.runs.flatMap((run) =>
        run.messages.flatMap((message) =>
            message.role === "agent" ? (message.content as readonly Block[]) : [],
        ),
    );
}

describe.skipIf(token === undefined)("Claude Fable 5.2, live", () => {
    let gym: AgentGym | undefined;
    afterEach(async ({ task }) => {
        if (gym !== undefined && task.result?.state === "fail") {
            console.log("HISTORY fable-5-2", JSON.stringify(await gym.history().catch(String)));
        }
        await gym?.dispose();
        gym = undefined;
    }, 60_000);

    it(
        "runs a shell tool call and answers with its output and its own name",
        async () => {
            gym = await createAgentGym({
                config: [
                    "[providers.live_claude]",
                    'type = "claude"',
                    "enabled = true",
                    `oauth_token = "${token}"`,
                    "",
                ].join("\n"),
                liveProviders: ["live_claude"],
                permissionMode: "full_access",
                timeoutMs: TURN_MS,
            });

            await gym.send(
                "Run the shell command `echo FABLE-$((6*7))` with your shell tool. Then reply with " +
                    "exactly two lines: the command's output, and the exact name of the model you " +
                    "are, as your instructions state it.",
                fable,
            );
            const blocks = agentBlocks(await gym.history());
            expect(blocks.some((block) => block.type === "tool_call")).toBe(true);
            const reply = blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("\n");
            expect(reply).toContain("FABLE-42");
            expect(reply).toContain("Fable 5.2");
        },
        TURN_MS + 60_000,
    );
});
