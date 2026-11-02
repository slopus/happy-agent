import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

it("removes phone attachments nobody wrote to for 30 days and keeps the rest out of Git", async () => {
    const gym = await createAgentGym();
    running.add(gym);
    const repository = join(dirname(gym.workspacePath), "uploads-repository");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "tracked.txt"), "tracked\n", "utf8");
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "gym@example.invalid"]);
    await git(repository, ["config", "user.name", "Uploads Gym"]);
    await git(repository, ["add", "tracked.txt"]);
    await git(repository, ["commit", "-m", "initial"]);
    const project = (await gym.client.registerProject({ path: repository })).project;
    await gym.waitUntil(async () => {
        const current = (await gym.client.getProject(project.id)).project;
        return current.initialization.status === "ready" ? current : undefined;
    }, "the project to initialize");

    // A phone's direct chat saves each attachment through the file API.
    const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    for (const message of ["expired-message", "recent-message"]) {
        await gym.client.writeFile(project.id, {
            content: picture,
            expectedHash: null,
            path: `.happy-uploads/${message}/1-photo.png`,
        });
    }
    const before = await gym.client.getWorkspaceGit(project.id);
    expect(before.git.files.map((file) => file.path).join("\n")).toContain(".happy-uploads");

    const expired = join(repository, ".happy-uploads", "expired-message");
    const aged = new Date(Date.now() - 31 * DAY);
    await utimes(join(expired, "1-photo.png"), aged, aged);
    await utimes(expired, aged, aged);
    const recent = join(repository, ".happy-uploads", "recent-message");
    const lastWeek = new Date(Date.now() - 7 * DAY);
    await utimes(join(recent, "1-photo.png"), lastWeek, lastWeek);
    await utimes(recent, lastWeek, lastWeek);

    // The daemon looks for expired attachments as it starts.
    await gym.restart();
    const left = await gym.waitUntil(async () => {
        const names = (await readdir(join(repository, ".happy-uploads"))).sort();
        return names.includes("expired-message") || !names.includes(".gitignore")
            ? undefined
            : names;
    }, "the expired attachments to be removed");

    expect(left).toEqual([".gitignore", "recent-message"]);
    await expect(readdir(recent)).resolves.toEqual(["1-photo.png"]);
    await expect(readFile(join(repository, ".happy-uploads", ".gitignore"), "utf8")).resolves.toBe(
        "*\n",
    );
    const after = await gym.client.getWorkspaceGit(project.id);
    expect(after.git.files.map((file) => file.path).join("\n")).not.toContain(".happy-uploads");
    expect(after.git.changedFiles).toBe(0);
    expect(gym.errors).toEqual([]);
}, 60_000);

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", [...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}
