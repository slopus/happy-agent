import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentGym, GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    FIRST_TASK_ASKED,
    SAVE_PROFILE,
    cue,
    reply,
    startGuidedGym,
    useRoutes,
} from "./support/guidedOnboardingGym.js";
import { OnboardingGyms, messagesOf, waitForSaid } from "./support/onboardingGym.js";

/**
 * Onboarding looks at the person's recent work with find_recent_projects: Happy reads Claude Code's
 * and Codex's history and each folder's Git metadata itself, so the Chief of Staff never runs a
 * shell for it, no call is reviewed, and the answer comes back in a second or two.
 */

const execFile = promisify(execFileCallback);
const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;
const SUGGESTED = "Here's what you've been up to, and where agents can help first:";

afterEach(async () => {
    await gyms.dispose();
});

/** Answers that look at the recent work once the person agreed, and say what came back. */
function looking(
    argumentsOf: Record<string, string>,
    said: string,
    timings: number[],
): Record<string, (request: GymInferenceRequest) => GymTurn> {
    return {
        "event:begin": () => SAVE_PROFILE,
        saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
        looked: () => {
            timings.push(Date.now());
            return { content: [{ text: said, type: "text" }] };
        },
        ...Object.fromEntries(
            Object.entries(argumentsOf).map(([words, folder]) => [
                `said:${words}`,
                () => {
                    timings.push(Date.now());
                    return {
                        content: [
                            {
                                type: "tool_call" as const,
                                name: "find_recent_projects",
                                arguments: folder === "" ? {} : { folder },
                            },
                        ],
                    };
                },
            ]),
        ),
    };
}

/** The result find_recent_projects gave, after checking that nothing was reviewed or run. */
async function lookedUp(gym: AgentGym, agentId: string): Promise<string> {
    const calls = (await messagesOf(gym, agentId)).flatMap((message) =>
        message.content.filter((block) => block.type === "tool_call"),
    ) as unknown as {
        name: string;
        status: string;
        result?: unknown;
        elevated?: boolean;
        review?: unknown;
    }[];
    // No shell and no automatic review: nothing asked to leave the sandbox.
    for (const call of calls) {
        expect(call.name).not.toMatch(/^(Bash|exec_command|bash|run_terminal_command)$/u);
        expect(call.elevated, call.name).toBeUndefined();
        expect(call.review, call.name).toBeUndefined();
    }
    const found = calls.find((call) => call.name === "find_recent_projects");
    if (found === undefined) throw new Error("find_recent_projects was not called.");
    expect(found.status).toBe("completed");
    return (found.result as { output: string }).output;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFile("git", args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Ada",
            GIT_AUTHOR_EMAIL: "ada@example.com",
            GIT_COMMITTER_NAME: "Ada",
            GIT_COMMITTER_EMAIL: "ada@example.com",
            GIT_TERMINAL_PROMPT: "0",
        },
    });
}

/** A repository with a branch, commits, and an uncommitted change, as Claude Code last saw it. */
async function recentSite(home: string): Promise<string> {
    const site = join(home, "code", "site");
    await mkdir(site, { recursive: true });
    await git(site, "init", "--initial-branch=main");
    await writeFile(join(site, "README.md"), "Install with the old installer.\n");
    await git(site, "add", ".");
    await git(site, "commit", "-m", "Describe the installer");
    await git(site, "checkout", "-b", "new-installer");
    await writeFile(join(site, "install.sh"), "# TODO: support arm64\n");
    await git(site, "add", ".");
    await git(site, "commit", "-m", "Add the new installer");
    await writeFile(join(site, "README.md"), "Install with install.sh.\n");
    const history = join(home, ".claude", "projects", "-code-site");
    await mkdir(history, { recursive: true });
    await writeFile(
        join(history, "session.jsonl"),
        `${JSON.stringify({ cwd: site, message: { content: "private words" } })}\n`,
    );
    return site;
}

describe("Onboarding looking at recent work", () => {
    it(
        "says at once that a computer with no history has no recent projects, without a shell or a review",
        async () => {
            const timings: number[] = [];
            const NOTHING =
                "I didn't find any recent projects on this computer, so let's start one.";
            const { gym, agentId } = await startGuidedGym(
                gyms,
                looking({ "Look at my recent work": "" }, NOTHING, timings),
            );
            await useRoutes(gym, agentId, ["codex"]);
            const asked = await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            await reply(gym, agentId, asked.id, 0);
            await waitForSaid(gym, agentId, NOTHING);

            const consented = gym.inference.requests.find(
                (request) => cue(request) === "said:Look at my recent work",
            );
            expect(consented?.instructions).toContain(
                "Call find_recent_projects to see their recent work, and nothing else",
            );
            const tool = consented?.tools.find(
                (candidate) => candidate.name === "find_recent_projects",
            );
            expect(tool?.defer).not.toBe(true);
            expect(await lookedUp(gym, agentId)).toBe(
                "No recent projects found: neither Claude Code nor Codex has worked in a folder on this computer that still exists.",
            );
            // From the person's consent to the model reading the answer.
            expect(timings).toHaveLength(2);
            expect(timings[1]! - timings[0]!).toBeLessThan(2_000);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "reads the projects Claude Code worked in and their Git activity, never their contents",
        async () => {
            const timings: number[] = [];
            const { gym, agentId, home } = await startGuidedGym(
                gyms,
                looking({ "Look at my recent work": "" }, SUGGESTED, timings),
            );
            const site = await recentSite(home);
            await useRoutes(gym, agentId, ["codex"]);
            const asked = await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            await reply(gym, agentId, asked.id, 0);
            await waitForSaid(gym, agentId, SUGGESTED);

            const result = await lookedUp(gym, agentId);
            expect(result).toContain("Recent projects on this computer, newest first.");
            expect(result).toContain(`1. site, at ${site}`);
            expect(result).toContain("Worked in with Claude Code just now.");
            expect(result).toContain("On branch new-installer.");
            expect(result).toContain("1 uncommitted change: README.md.");
            expect(result).toContain('"Add the new installer"');
            expect(result).toContain(
                'Recent commits touching TODO or FIXME lines: "Add the new installer"',
            );
            expect(result).not.toContain("private words");
            expect(result).not.toContain("support arm64");
            expect(timings[1]! - timings[0]!).toBeLessThan(3_000);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "reads a folder the person named instead of the history",
        async () => {
            const timings: number[] = [];
            const { gym, agentId, home } = await startGuidedGym(gyms, {
                ...looking({ "~/code/site": "~/code/site" }, SUGGESTED, timings),
                "said:I'll name a folder": () => ({
                    content: [{ text: "Which folder should I look at?", type: "text" }],
                }),
            });
            const site = await recentSite(home);
            await useRoutes(gym, agentId, ["codex"]);
            const asked = await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            await reply(gym, agentId, asked.id, 1);
            await waitForSaid(gym, agentId, "Which folder should I look at?");
            await gym.send("~/code/site", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, SUGGESTED);

            const result = await lookedUp(gym, agentId);
            expect(result).toContain(`The folder they named.`);
            expect(result).toContain(`1. site, at ${site}`);
            expect(result).toContain("On branch new-installer.");
            expect(result).not.toContain("Worked in with");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
