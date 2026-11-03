import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    clientFrameEvent,
    createAgentGym,
    type AgentGym,
    type GymRunner,
    type HappyAgentEventStream,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TOKEN = "d".repeat(43);
const running = new Set<AgentGym>();
const streams = new Set<HappyAgentEventStream>();

afterEach(async () => {
    for (const stream of streams) stream.close();
    streams.clear();
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * Either side stopping on purpose says goodbye, so the other learns of it within a second or two
 * rather than after an idle timeout; and while a runner is away, every route reading its folders
 * answers `503 runner_unavailable` instead of a 500 or a misleading 404.
 */
describe("a runner that goes away", { timeout: 90_000 }, () => {
    it("is seen at once when it stops, and its folders answer 503 until it is back", async () => {
        const { gym, runner, home, workspaceId } = await runnerFolder();
        const stream = gym.stream();
        streams.add(stream);
        await stream.opened();
        await gym.client.watchGit({ workspaceIds: [workspaceId] });

        const stoppedAt = Date.now();
        await runner.stop();
        await runnerStatus(stream, "disconnected");
        expect(Date.now() - stoppedAt).toBeLessThan(2_000);

        for (const request of [
            () => gym.client.readFile(workspaceId, "readme.txt"),
            () => gym.client.getFileTree(workspaceId),
            () => gym.client.searchFiles(workspaceId, { query: "readme", limit: 10 }),
            () => gym.client.getWorkspaceGit(workspaceId),
            () =>
                gym.client.readFileRevision(workspaceId, { path: "readme.txt", revision: "HEAD" }),
            () =>
                gym.client.writeFile(workspaceId, {
                    content: Buffer.from("x").toString("base64"),
                    expectedHash: null,
                    path: "new.txt",
                }),
            () => gym.client.openTerminal(workspaceId),
        ]) {
            await expect(request()).rejects.toMatchObject({
                status: 503,
                code: "runner_unavailable",
            });
        }

        // Back again, the same folder answers as before.
        const returned = await gym.startRunner({ home, token: TOKEN });
        await runnerStatus(stream, "connected", stream.frames.length);
        const file = await gym.client.readFile(workspaceId, "readme.txt");
        expect(Buffer.from(file.content, "base64").toString("utf8")).toBe("hello\n");

        // A runner that dies without a goodbye on a local connection is seen as soon as it closes.
        const killedAt = Date.now();
        await returned.kill();
        await runnerStatus(stream, "disconnected", stream.frames.length);
        expect(Date.now() - killedAt).toBeLessThan(2_000);
        expect(gym.errors).toEqual([]);
    });

    it("reconnects within seconds when its daemon restarts", async () => {
        const { gym, runner, workspaceId } = await runnerFolder();
        await gym.restart();
        const restartedAt = Date.now();
        await gym.waitUntil(async () => await connected(gym), "the runner to come back", 15_000);
        // The goodbye ends the runner's connection at once, so it retries at its quick pace
        // instead of waiting for an idle timeout or a long backoff.
        expect(Date.now() - restartedAt).toBeLessThan(8_000);
        const file = await gym.client.readFile(workspaceId, "readme.txt");
        expect(Buffer.from(file.content, "base64").toString("utf8")).toBe("hello\n");
        expect(runner.output).toContain("The daemon is shutting down.");
    });
});

/** A gym with one runner connected and a project folder on it. */
async function runnerFolder(): Promise<{
    gym: AgentGym;
    runner: GymRunner;
    home: string;
    workspaceId: string;
}> {
    const gym = await createAgentGym({
        config: `[runners]\ndefault = "local"\n\n[runners.box]\nname = "Box"\ntoken = "${TOKEN}"\n`,
        timeoutMs: 30_000,
    });
    running.add(gym);
    const home = join(dirname(gym.workspacePath), "runner-home");
    const runner = await gym.startRunner({ home, token: TOKEN });
    await gym.waitUntil(async () => await connected(gym), "the runner to connect");
    const folder = join(home, "folder");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "readme.txt"), "hello\n", "utf8");
    const project = (await gym.client.registerProject({ path: folder, runnerId: "box" })).project;
    await gym.waitUntil(async () => {
        const current = (await gym.client.getProject(project.id)).project;
        if (current.initialization.status === "failed")
            throw new Error(current.initialization.error ?? "The project could not be set up.");
        return current.initialization.status === "ready" ? true : undefined;
    }, "the runner project to become ready");
    return { gym, runner, home, workspaceId: project.id };
}

async function connected(gym: AgentGym): Promise<true | undefined> {
    const { runners } = await gym.client.listRunners();
    return runners.some((runner) => runner.id === "box" && runner.status === "connected")
        ? true
        : undefined;
}

/** Wait for a `runners.updated` at or after frame `from` that reports the runner in `status`. */
async function runnerStatus(
    stream: HappyAgentEventStream,
    status: "connected" | "disconnected",
    from = 0,
): Promise<void> {
    const earlier = new Set(stream.frames.slice(0, from));
    await stream.waitFor((frame) => {
        if (earlier.has(frame)) return false;
        const event = clientFrameEvent(frame);
        return (
            event?.type === "runners.updated" &&
            event.payload.runners.some((runner) => runner.id === "box" && runner.status === status)
        );
    }, `the runner to be ${status}`);
}
