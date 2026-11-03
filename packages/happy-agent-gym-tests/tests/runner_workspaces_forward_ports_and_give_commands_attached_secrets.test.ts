import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
    connectBridgeWebSocket,
    createAgentGym,
    type AgentGym,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type WorkspaceBridge = Awaited<
    ReturnType<AgentGym["client"]["listWorkspaceBridges"]>
>["bridges"][number];

const execFile = promisify(execFileCallback);
const TOKEN = "b".repeat(43);
const SECRET_VALUE = "runner-secret-gym-value";
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * A workspace on a runner forwards a port from the runner to the client, says plainly that USB and
 * Bluetooth are not supported there, and gives an agent's command there the attached secrets it
 * selected, resolved on the daemon and sent with that one command.
 */
describe("a workspace on a runner", { timeout: 90_000 }, () => {
    it("forwards a port on the runner and reports USB and Bluetooth as unsupported", async () => {
        const { gym, workspaceId } = await runnerProject();
        const transport = { socketPath: gym.socketPath, token: gym.token };
        const unsupported = {
            code: "runner_compute",
            message: "USB and Bluetooth are not supported on runners.",
        };

        expect((await gym.client.listWorkspaceBridges(workspaceId)).capabilities).toEqual({
            usb: { available: false, reason: unsupported },
            bluetooth: { available: false, transport: "usb", reason: unsupported },
            localToWorkspace: { available: true, reason: null },
            workspaceToLocal: { available: true, reason: null },
        });

        const control = await connectBridgeWebSocket(
            gym.client.workspacePortBridgeUrl(workspaceId, { port: 0, name: "Database" }),
            transport,
        );
        const ready = await control.nextJson();
        const bridge = ready["bridge"] as WorkspaceBridge;
        expect(bridge).toMatchObject({ kind: "port", status: "open", workspaceId });

        // The runner shares this computer's loopback, so a program on it connects from here.
        const program = connect(bridge.port!.port, "127.0.0.1");
        program.on("error", () => undefined);
        let announced: Record<string, unknown>;
        do announced = await control.nextJson();
        while (announced["type"] !== "connection");
        const carrier = await connectBridgeWebSocket(
            gym.client.workspaceBridgeConnectionUrl(
                workspaceId,
                bridge.id,
                announced["connectionId"] as string,
            ),
            transport,
        );
        program.write("SELECT 1;");
        expect(await carrier.next()).toEqual({ binary: true, data: Buffer.from("SELECT 1;") });
        const answer = new Promise<string>((resolve) => {
            program.once("data", (data: Buffer) => resolve(data.toString()));
        });
        carrier.send(Buffer.from("1 row"));
        await expect(answer).resolves.toBe("1 row");

        await gym.client.closeWorkspaceBridge(workspaceId, bridge.id);
        expect((await control.closed).code).toBe(1000);
        program.destroy();
    });

    it("gives an agent's command there the attached secrets it selected", async () => {
        const { gym, repository, workspaceId } = await runnerProject([
            {
                content: [
                    {
                        type: "tool_call",
                        name: "exec_command",
                        arguments: {
                            cmd: 'printf "%s" "$DEPLOY_TOKEN" > secret.txt',
                            secrets: ["deploy"],
                        },
                    },
                ],
            },
            { content: [{ type: "text", text: "Saved." }] },
        ]);
        await gym.client.createSecret({
            id: "deploy",
            description: "Deployment credentials",
            environment: { DEPLOY_TOKEN: SECRET_VALUE },
        });
        await gym.client.attachSecret("deploy", { type: "project", id: workspaceId });
        const { agent } = await gym.client.createAgent({ workspaceId });
        await gym.send("Save the deploy token.", {
            sessionId: agent.id,
            permissionMode: "full_access",
        });

        expect(gym.inference.unscripted).toEqual([]);
        expect(await readFile(join(repository, "secret.txt"), "utf8")).toBe(SECRET_VALUE);
        expect(JSON.stringify((await gym.client.getEvents()).events)).not.toContain(SECRET_VALUE);
    });
});

async function runnerProject(inference: readonly GymTurn[] = []) {
    const gym = await createAgentGym({
        inference: [...inference],
        config: `[runners]\ndefault = "local"\n\n[runners.box]\nname = "Box"\ntoken = "${TOKEN}"\n`,
        timeoutMs: 30_000,
    });
    running.add(gym);
    const home = join(dirname(gym.workspacePath), "runner-home");
    await gym.startRunner({ home, token: TOKEN });
    await gym.waitUntil(
        async () =>
            (await gym.client.listRunners()).runners.find(
                (runner) => runner.id === "box" && runner.status === "connected",
            ),
        "the runner to connect",
    );

    const repository = join(home, "repository");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "readme.txt"), "hello\n", "utf8");
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
    return { gym, repository, workspaceId: project.id };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile(
        "git",
        ["-c", "user.email=gym@example.invalid", "-c", "user.name=Runner Gym", ...args],
        { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
}
