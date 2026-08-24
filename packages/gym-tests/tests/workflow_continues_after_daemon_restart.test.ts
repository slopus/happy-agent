import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

describe("workflow recovery after a daemon restart", () => {
    it("continues with the restored collaborator without a manual resume", async () => {
        let parentSessionId: string | undefined;
        let parentCalls = 0;
        let childCalls = 0;
        let workflowId = "";
        const childSessionIds = new Set<string>();
        const gym = await createGym({
            environment: { HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON: "0" },
            inference: (request) => {
                parentSessionId ??= request.options.sessionId;
                if (request.options.sessionId === parentSessionId) {
                    parentCalls += 1;
                    if (parentCalls === 1) {
                        return {
                            content: [
                                {
                                    arguments: {
                                        input: {
                                            name: "restart recovery",
                                            script: [
                                                'agent("Finish after the daemon restarts.", {',
                                                '    "effort": "off",',
                                                '    "label": "Restart recovery collaborator",',
                                                '    "model": "openai/gym"',
                                                "})",
                                            ].join("\n"),
                                        },
                                    },
                                    callId: "restartworkflow",
                                    name: "run_workflow",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    if (parentCalls === 2) {
                        const transcript = JSON.stringify(request.context.messages);
                        workflowId =
                            /restart recovery \(([^)]+)\) is running/u.exec(transcript)?.[1] ?? "";
                        expect(workflowId).not.toBe("");
                        return {
                            content: [{ text: "WORKFLOW_STARTED_BEFORE_RESTART", type: "text" }],
                        };
                    }
                    if (parentCalls === 3) {
                        return {
                            content: [
                                {
                                    arguments: { id: workflowId },
                                    callId: "waitrestartedworkflow",
                                    name: "wait_workflow",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }

                    const transcript = JSON.stringify(request.context.messages);
                    return {
                        content: [
                            {
                                text:
                                    transcript.includes("restart recovery") &&
                                    transcript.includes("is completed") &&
                                    transcript.includes("WORKFLOW_CHILD_FINISHED")
                                        ? "WORKFLOW_RESTART_RECOVERED"
                                        : "WORKFLOW_RESTART_DID_NOT_RECOVER",
                                type: "text",
                            },
                        ],
                    };
                }

                childCalls += 1;
                childSessionIds.add(request.options.sessionId ?? "");
                return childCalls === 1
                    ? {
                          content: [{ text: "STALE_PRE_RESTART_ANSWER", type: "text" }],
                          delayMs: 120_000,
                      }
                    : {
                          content: [{ text: "WORKFLOW_CHILD_FINISHED", type: "text" }],
                      };
            },
            timeoutMs: 30_000,
        });
        running.add(gym);

        submit(gym, "Run a one-agent workflow and leave it working in the background.");
        await gym.terminal.waitForText("WORKFLOW_STARTED_BEFORE_RESTART", 30_000);
        await gym.terminal.waitUntil(
            () => childCalls === 1,
            "the workflow collaborator to enter inference",
            10_000,
        );

        await crashDaemon(gym);
        submit(gym, "/reload");
        await gym.terminal.waitForText("Resumed", 30_000);
        await gym.terminal.waitUntil(
            () => childCalls >= 2,
            "the restored workflow collaborator to finish",
            30_000,
        );

        submit(gym, `Wait for ${workflowId} and report its result without resuming it.`);
        const recovered = await gym.terminal.waitForText("WORKFLOW_RESTART_RECOVERED", 30_000);
        expect(recovered.text).not.toContain("WORKFLOW_RESTART_DID_NOT_RECOVER");
        expect(childSessionIds.size).toBe(1);
        expect(childCalls).toBe(2);
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function crashDaemon(gym: Gym): Promise<void> {
    await gym.runInContainer(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const pidPath = join(process.env.HOME, ".happy", "agent", "daemon.pid");
const pid = Number((await readFile(pidPath, "utf8")).trim());
process.kill(pid, "SIGKILL");
for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
        process.exit(0);
    }
}
throw new Error("The crashed daemon did not exit.");
`,
        ],
        { timeoutMs: 10_000 },
    );
}
