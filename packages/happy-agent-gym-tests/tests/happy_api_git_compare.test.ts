import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/*
 * The typed client's `compareWorkspaceGit` ships in the client release that follows this
 * specification; until the gym depends on it, the route is driven through the raw socket.
 */
describe("comparing two commits through the public API", () => {
    it("lists the files between two commits and refuses what is not a commit", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const repositoryPath = join(dirname(gym.workspacePath), "compare-repository");
        await mkdir(repositoryPath, { recursive: true });
        await git(repositoryPath, ["init", "--initial-branch=main"]);
        await git(repositoryPath, ["config", "user.email", "gym@example.invalid"]);
        await git(repositoryPath, ["config", "user.name", "API Gym"]);
        await writeFile(join(repositoryPath, "kept.txt"), "kept\n", "utf8");
        await writeFile(join(repositoryPath, "edited.txt"), "one\n", "utf8");
        await git(repositoryPath, ["add", "--all"]);
        await git(repositoryPath, ["commit", "-m", "initial"]);
        const base = await revParse(repositoryPath, "HEAD");
        await writeFile(join(repositoryPath, "edited.txt"), "two\n", "utf8");
        await writeFile(join(repositoryPath, "added.txt"), "new\n", "utf8");
        await git(repositoryPath, ["add", "--all"]);
        await git(repositoryPath, ["commit", "-m", "second"]);
        const head = await revParse(repositoryPath, "HEAD");

        const registered = (await gym.client.registerProject({ path: repositoryPath })).project;
        await gym.waitUntil(async () => {
            const project = (await gym.client.getProject(registered.id)).project;
            return project.initialization.status === "ready" ? project : undefined;
        }, "the Git project to initialize");

        const route = `/v0/workspaces/${registered.id}/git/compare`;
        const compared = await gym.raw.request<{
            files: { path: string; status: string }[];
            filesTruncated: boolean;
        }>("GET", `${route}?base=${base}&head=${head}`);
        expect(compared.status).toBe(200);
        expect(compared.body.filesTruncated).toBe(false);
        expect(
            [...compared.body.files].sort((left, right) => left.path.localeCompare(right.path)),
        ).toEqual([
            { path: "added.txt", status: "added" },
            { path: "edited.txt", status: "modified" },
        ]);

        // A commit-ish is enough, and the same commit on both sides differs in nothing.
        const symbolic = await gym.raw.request("GET", `${route}?base=HEAD~1&head=HEAD`);
        expect(symbolic.status).toBe(200);
        expect(symbolic.body).toEqual(compared.body);
        const same = await gym.raw.request("GET", `${route}?base=${head}&head=${head}`);
        expect(same.body).toEqual({ files: [], filesTruncated: false });

        const unknown = await gym.raw.request(
            "GET",
            `${route}?base=${"f".repeat(40)}&head=${head}`,
        );
        expect(unknown.status).toBe(400);
        const option = await gym.raw.request(
            "GET",
            `${route}?base=${encodeURIComponent("--output=/tmp/x")}&head=${head}`,
        );
        expect(option.status).toBe(400);
        const missing = await gym.raw.request("GET", `${route}?base=${base}`);
        expect(missing.status).toBe(400);
    });

    it("answers 404 for a workspace that is not a repository", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const plainPath = join(dirname(gym.workspacePath), "plain-folder");
        await mkdir(plainPath, { recursive: true });
        await writeFile(join(plainPath, "note.txt"), "no history here\n", "utf8");
        const registered = (await gym.client.registerProject({ path: plainPath })).project;
        await gym.waitUntil(async () => {
            const project = (await gym.client.getProject(registered.id)).project;
            return project.initialization.status === "ready" ? project : undefined;
        }, "the plain project to initialize");

        const answer = await gym.raw.request(
            "GET",
            `/v0/workspaces/${registered.id}/git/compare?base=HEAD~1&head=HEAD`,
        );
        expect(answer.status).toBe(404);
    });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", [...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
}

async function revParse(cwd: string, revision: string): Promise<string> {
    const { stdout } = await execFile("git", ["rev-parse", revision], { cwd });
    return stdout.trim();
}
