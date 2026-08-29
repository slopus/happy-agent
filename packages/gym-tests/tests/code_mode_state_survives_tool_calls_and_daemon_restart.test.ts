import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Code Mode state persistence", () => {
    it("resumes the same turn from a committed Python checkpoint after SIGKILL", async () => {
        let agentId: string | undefined;
        const secondInferenceReached = deferred<void>();
        const releaseCrashedInference = deferred<void>();
        const gym = await createGym({
            environment: { HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON: "0" },
            homeFiles: {
                "Happy/Config/happy.toml": "[feature.codemode]\nenabled = true\n",
            },
            async inference(request, callIndex) {
                const requestAgentId = request.options.sessionId;
                if (requestAgentId === undefined)
                    throw new Error("Code Mode request had no agent ID.");
                agentId ??= requestAgentId;
                expect(requestAgentId).toBe(agentId);

                const transcript = JSON.stringify(request.context.messages);
                if (callIndex === 0) {
                    expect(request.context.systemPrompt).toContain("Code Mode");
                    expect(request.context.tools?.map((tool) => tool.name)).toEqual(["python"]);
                    return {
                        content: [
                            {
                                arguments: { code: "counter = 41\ncounter" },
                                id: "codemodeset",
                                name: "python",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(transcript).toContain("result:\\n41");
                    secondInferenceReached.resolve();
                    await releaseCrashedInference.promise;
                    return {
                        content: [{ text: "THE_CRASHED_INFERENCE_MUST_NOT_RENDER", type: "text" }],
                    };
                }
                if (callIndex === 2) {
                    expect(transcript).toContain("result:\\n41");
                    return {
                        content: [
                            {
                                arguments: { code: "counter += 1\ncounter" },
                                id: "codemodeupdate",
                                name: "python",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 3) {
                    expect(transcript).toContain("result:\\n42");
                    return {
                        content: [{ text: "CODE_MODE_RESTART_RESTORED_42", type: "text" }],
                    };
                }
                throw new Error(`Unexpected Code Mode inference ${callIndex}.`);
            },
            timeoutMs: 30_000,
        });
        running.add(gym);

        try {
            submit(gym, "Set and update a Code Mode counter with two Python calls.");
            await secondInferenceReached.promise;

            if (agentId === undefined) throw new Error("Code Mode never reached inference.");
            const persisted = await inspectSnapshot(gym, agentId);
            expect(persisted.size).toBeGreaterThan(0);
            expect(persisted.mode).toBe(0o600);

            await crashDaemon(gym);
            releaseCrashedInference.resolve();
            submit(gym, "/reload");
            const restored = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("CODE_MODE_RESTART_RESTORED_42") &&
                    !snapshot.text.includes("THE_CRASHED_INFERENCE_MUST_NOT_RENDER") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything"),
                "the interrupted turn to resume from its Code Mode checkpoint",
                30_000,
            );
            expect(restored.text).toContain("CODE_MODE_RESTART_RESTORED_42");
        } finally {
            releaseCrashedInference.resolve();
        }
    }, 120_000);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function inspectSnapshot(
    gym: Gym,
    agentId: string,
): Promise<{ readonly mode: number; readonly size: number }> {
    const result = await gym.runInContainer("node", [
        "--input-type=module",
        "--eval",
        `
import { stat } from "node:fs/promises";
import { join } from "node:path";
const snapshotPath = join(
    process.env.HOME,
    ".happy",
    "agent",
    "state",
    ${JSON.stringify(agentId)},
    "snapshot.bin",
);
const snapshot = await stat(snapshotPath);
console.log(JSON.stringify({ mode: snapshot.mode & 0o777, size: snapshot.size }));
`,
    ]);
    return JSON.parse(result.stdout) as { readonly mode: number; readonly size: number };
}

async function crashDaemon(gym: Gym): Promise<void> {
    await gym.runInContainer(
        "node",
        [
            "--input-type=module",
            "--eval",
            `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const lockPath = join(process.env.HOME, ".happy", "agent", "agent.lock");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
process.kill(lock.pid, "SIGKILL");
for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
        process.kill(lock.pid, 0);
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
