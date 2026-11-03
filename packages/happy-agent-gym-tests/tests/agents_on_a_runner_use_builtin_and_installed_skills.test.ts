import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const TOKEN = "s".repeat(43);
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

/**
 * Skills are files an agent reads and runs on its own machine. An agent on a runner finds the
 * daemon's native skills and this installation's own installed skills, scripts and references
 * included, copied to the runner, and its prompt points at the runner's copy of the documentation.
 */
describe("an agent on a runner", { timeout: 120_000 }, () => {
    it("lists and reads builtin and installed skills, reads a reference, and runs a script", async () => {
        const steps: GymTurn[] = [];
        const instructions: string[] = [];
        const gym = await createAgentGym({
            config: `[runners]\ndefault = "local"\n\n[runners.box]\nname = "Box"\ntoken = "${TOKEN}"\n`,
            timeoutMs: 30_000,
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "Skills" }] };
                }
                if (!lastUserText(request).includes("use-the-skills")) {
                    return { content: [{ type: "text", text: "Settled." }] };
                }
                instructions.push(request.instructions);
                const done = request.messages.filter((message) => message.role === "tool").length;
                return steps[done] ?? { content: [{ type: "text", text: "Done." }] };
            },
        });
        running.add(gym);

        // What a daemon start installs in its Happy home: documentation and a native skill. The
        // gym starts the daemon in process, which skips that step.
        const happyHome = join(dirname(gym.workspacePath), ".happy");
        await mkdir(join(happyHome, "docs"), { recursive: true });
        await writeFile(join(happyHome, "docs", "README.md"), "Happy Agent documentation.\n");
        await mkdir(join(happyHome, "skills", "guided-review"), { recursive: true });
        await writeFile(
            join(happyHome, "skills", "guided-review", "SKILL.md"),
            "---\nname: guided-review\ndescription: Review a change.\n---\nWalk through it.\n",
        );

        // A skill installed for this installation, on the daemon's machine.
        const installed = join(dirname(gym.workspacePath), "home", ".agents", "skills", "deployer");
        await mkdir(join(installed, "scripts"), { recursive: true });
        await mkdir(join(installed, "references"), { recursive: true });
        await writeFile(
            join(installed, "SKILL.md"),
            "---\nname: deployer\ndescription: Deploy the project.\n---\nRun scripts/deploy.sh.\n",
        );
        await writeFile(join(installed, "references", "steps.md"), "Step one: deploy.\n");
        await writeFile(
            join(installed, "scripts", "deploy.sh"),
            '#!/bin/sh\necho "deployed on $HOME"\n',
        );
        await chmod(join(installed, "scripts", "deploy.sh"), 0o755);

        const home = join(dirname(gym.workspacePath), "runner-home");
        await mkdir(home, { recursive: true });
        const runnerHome = await realpath(home);
        await gym.startRunner({ home: runnerHome, token: TOKEN });
        const synced = join(runnerHome, ".happy-agent", "synced-skills");
        const mirrored = await gym.waitUntil(async () => {
            const entries = await readdir(synced).catch(() => [] as string[]);
            const folder = entries.find((entry) => entry.startsWith("deployer-"));
            return folder === undefined ? undefined : join(synced, folder);
        }, "the installed skill to reach the runner");

        const repository = join(runnerHome, "repository");
        await mkdir(repository, { recursive: true });
        await writeFile(join(repository, "readme.txt"), "hello\n");
        await git(repository, ["init", "--quiet", "--initial-branch=main"]);
        await git(repository, ["add", "."]);
        await git(repository, ["commit", "--quiet", "-m", "initial"]);
        const project = (await gym.client.registerProject({ path: repository, runnerId: "box" }))
            .project;
        await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(project.id)).project;
            if (current.initialization.status === "failed")
                throw new Error(current.initialization.error ?? "The project could not be set up.");
            return current.initialization.status === "ready" ? true : undefined;
        }, "the runner project to become ready");
        const { agent } = await gym.client.createAgent({ workspaceId: project.id });

        steps.push(
            call("list", "list_skills", {}),
            call("builtin", "read_skill", { name: "guided-review" }),
            call("installed", "read_skill", { name: "deployer" }),
            call("run", "exec_command", {
                cmd: `cat '${join(mirrored, "references", "steps.md")}' && '${join(mirrored, "scripts", "deploy.sh")}'`,
            }),
        );
        await gym.send("Please use-the-skills.", {
            sessionId: agent.id,
            permissionMode: "full_access",
        });

        const result = (callId: string) =>
            gym.inference.toolResults().find((item) => item.callId === callId)?.text ?? "";
        expect(result("list")).toContain("guided-review");
        expect(result("list")).toContain("deployer");
        expect(result("list")).toContain(join(runnerHome, ".happy-agent", "skills"));
        expect(result("builtin")).toContain("name: guided-review");
        expect(result("installed")).toContain("Run scripts/deploy.sh.");
        expect(result("run")).toContain("Step one: deploy.");
        expect(result("run")).toContain(`deployed on ${runnerHome}`);
        expect(instructions[0]).toContain(join(runnerHome, ".happy-agent", "docs", "README.md"));
        await expect(
            readFile(join(runnerHome, ".happy-agent", "docs", "README.md"), "utf8"),
        ).resolves.toBe("Happy Agent documentation.\n");
        expect(gym.inference.unscripted).toEqual([]);
    });
});

function call(callId: string, name: string, args: Record<string, unknown>): GymTurn {
    return { content: [{ type: "tool_call", name, arguments: args, callId }] };
}

function lastUserText(request: GymInferenceRequest): string {
    return (request.messages.findLast((message) => message.role === "user")?.content ?? [])
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile(
        "git",
        ["-c", "user.email=gym@example.invalid", "-c", "user.name=Runner Gym", ...args],
        { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
}
