import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("initializing managed workspace inference", () => {
    it("accepts an idempotent session and message, then starts the queued run after setup", async () => {
        const gym = await createGym({
            files: {
                "exercise-initializing-workspace.mjs": exerciseInitializingWorkspace,
                "hold-workspace-setup.mjs": holdWorkspaceSetup,
                "rig.toml": [
                    "[workspace]",
                    'setup_commands = ["node hold-workspace-setup.mjs"]',
                    "",
                ].join("\n"),
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node exercise-initializing-workspace.mjs" },
                            id: "exercise-initializing-workspace",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                {
                    content: [
                        {
                            arguments: { cmd: "cat workspace-setup-finished.txt" },
                            id: "verify-workspace-setup",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                {
                    content: [{ text: "Queued workspace inference completed.", type: "text" }],
                },
                {
                    content: [
                        { text: "The initializing workspace queue is verified.", type: "text" },
                    ],
                },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Verify inference waits for an initializing managed workspace.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(
            "The initializing workspace queue is verified.",
            60_000,
        );
        expect(screen.text).toContain("The initializing workspace queue is verified.");
        await expect(gym.readFile("initializing-workspace-result.json")).resolves.toBe(
            JSON.stringify({
                initialWorkspaceStatus: "initializing",
                queuedSessionStatus: "queued",
                retriedMessageMatched: true,
                retriedSessionMatched: true,
                retriedWorkspaceMatched: true,
                runFinished: true,
            }),
        );

        const agentRequests = gym.inference.requests.filter(
            (request) => request.options.sessionId?.endsWith(":title") !== true,
        );
        expect(agentRequests).toHaveLength(4);
        expect(agentRequests[1]?.context.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    content: expect.arrayContaining([
                        expect.objectContaining({
                            text: "Run after the managed workspace is ready.",
                            type: "text",
                        }),
                    ]),
                    role: "user",
                }),
            ]),
        );
    }, 120_000);
});

const holdWorkspaceSetup = String.raw`
import { access, writeFile } from "node:fs/promises";

await writeFile("/workspace/workspace-setup-started.txt", "started\n");
for (let attempt = 0; attempt < 800; attempt += 1) {
    try {
        await access("/workspace/release-workspace-setup.txt");
        await writeFile("workspace-setup-finished.txt", "finished\n");
        process.exit(0);
    } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
throw new Error("Timed out waiting to release workspace setup.");
`;

const exerciseInitializingWorkspace = String.raw`
import { access, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { execFileSync } from "node:child_process";

execFileSync("git", ["init"], { cwd: "/workspace", stdio: "ignore" });
execFileSync("git", ["config", "user.email", "gym@example.test"], { cwd: "/workspace" });
execFileSync("git", ["config", "user.name", "Rig Gym"], { cwd: "/workspace" });
await writeFile("/workspace/README.md", "initializing workspace queue fixture\n");
execFileSync(
    "git",
    [
        "add",
        "README.md",
        "rig.toml",
        "hold-workspace-setup.mjs",
        "exercise-initializing-workspace.mjs",
    ],
    { cwd: "/workspace" },
);
execFileSync("git", ["commit", "-m", "Initial"], { cwd: "/workspace", stdio: "ignore" });

const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();

function requestJson(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                socketPath,
                path,
                method,
                headers: {
                    authorization: "Bearer " + token,
                    accept: "application/json",
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-type": "application/json",
                              "content-length": Buffer.byteLength(payload),
                          }),
                },
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(new Error(text));
                        return;
                    }
                    resolve(text.length === 0 ? {} : JSON.parse(text));
                });
            },
        );
        outgoing.on("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}

async function waitForFile(path) {
    for (let attempt = 0; attempt < 800; attempt += 1) {
        try {
            await access(path);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    throw new Error("Timed out waiting for " + path);
}

const catalog = await requestJson("GET", "/catalog");
const project = catalog.projects.find((candidate) => candidate.path === "/workspace");
if (project === undefined) throw new Error("The source project is missing.");

const workspaceRequest = {
    baseRef: "HEAD",
    id: "w6q0tc4rmq9f4a6adczq9eis",
    name: "Queued inference",
};
const firstWorkspace = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    workspaceRequest,
);
const retriedWorkspace = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    workspaceRequest,
);
await waitForFile("/workspace/workspace-setup-started.txt");

const sessionRequest = {
    cwd: firstWorkspace.workspace.path,
    id: "d044lyyqklbc850un07gpm9v",
    projectId: project.id,
    workspaceId: firstWorkspace.workspace.id,
};
const firstSession = await requestJson("POST", "/sessions", sessionRequest);
const retriedSession = await requestJson("POST", "/sessions", sessionRequest);
const messageRequest = {
    clientSubmissionId: "m7ymgv1cqfbjd0pxukc8403w",
    text: "Run after the managed workspace is ready.",
};
const firstMessage = await requestJson(
    "POST",
    "/sessions/" + encodeURIComponent(firstSession.session.id) + "/messages",
    messageRequest,
);
const retriedMessage = await requestJson(
    "POST",
    "/sessions/" + encodeURIComponent(firstSession.session.id) + "/messages",
    messageRequest,
);
const queued = await requestJson(
    "GET",
    "/sessions/" + encodeURIComponent(firstSession.session.id),
);
if (queued.session.status !== "queued") {
    throw new Error("The initializing workspace run was not queued.");
}

await writeFile("/workspace/release-workspace-setup.txt", "release\n");
let runFinished = false;
for (let attempt = 0; attempt < 800; attempt += 1) {
    const history = await requestJson(
        "GET",
        "/sessions/" + encodeURIComponent(firstSession.session.id) + "/events",
    );
    runFinished = history.events.some(
        (event) => event.type === "run_finished" && event.data.runId === firstMessage.runId,
    );
    if (runFinished) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
}

await writeFile(
    "/workspace/initializing-workspace-result.json",
    JSON.stringify({
        initialWorkspaceStatus: firstWorkspace.workspace.status,
        queuedSessionStatus: queued.session.status,
        retriedMessageMatched: retriedMessage.runId === firstMessage.runId,
        retriedSessionMatched: retriedSession.session.id === firstSession.session.id,
        retriedWorkspaceMatched: retriedWorkspace.workspace.id === firstWorkspace.workspace.id,
        runFinished,
    }),
);
`;
