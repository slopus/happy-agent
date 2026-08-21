import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "MANAGED_WORKSPACE_PATHS_SURVIVED_DIRECTORY_CHANGE";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("managed workspace directory changes", () => {
    it("keeps persisted paths authoritative while new workspaces use the new override", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/exercise-workspace-directory-change.sh"],
            files: {
                "exercise-workspace-directory-change.sh": exerciseWorkspaceDirectoryChangeScript,
                "workspace-directory-client.mjs": workspaceDirectoryClientScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Persisted workspace path remained usable");
        expect(screen.text).toContain(COMPLETED_MARKER);
        await expect(gym.readFile("workspace-directory-change-result.json")).resolves.toBe(
            JSON.stringify({
                newPath: "/workspace/managed-second/workspace/new-root",
                oldPath: "/workspace/managed-first/workspace/old-root",
                oldRemoved: true,
            }),
        );
    }, 120_000);
});

const exerciseWorkspaceDirectoryChangeScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/happy-terminal/dist/main.js "$@"
}

export HAPPY_TERMINAL_SERVER_DIRECTORY="/home/happy-terminal/.local/state/rig-workspace-directory-change"
export HAPPY_TERMINAL_SERVER_SOCKET_PATH="/tmp/rig-workspace-directory-change.sock"
first_root="/workspace/managed-first"
second_root="/workspace/managed-second"
registry_path="$HAPPY_TERMINAL_SERVER_DIRECTORY/server.json"

read_registered_pid() {
    node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).pid))' "$registry_path"
}

wait_for_exit() {
    local target_pid="$1"
    for _ in $(seq 1 200); do
        if ! kill -0 "$target_pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.05
    done
    echo "Daemon process $target_pid did not exit." >&2
    return 1
}

git -C /workspace init --initial-branch=main
git -C /workspace config user.email gym@example.test
git -C /workspace config user.name "Happy Terminal Gym"
printf 'managed workspace path fixture\n' > /workspace/README.md
git -C /workspace add README.md
git -C /workspace commit -m Initial

HAPPY_AGENT_WORKSPACES_DIRECTORY="$first_root" happy-terminal daemon start
first_pid="$(read_registered_pid)"
HAPPY_AGENT_WORKSPACES_DIRECTORY="$first_root" node /workspace/workspace-directory-client.mjs create-old
HAPPY_AGENT_WORKSPACES_DIRECTORY="$first_root" happy-terminal daemon stop
wait_for_exit "$first_pid"

HAPPY_AGENT_WORKSPACES_DIRECTORY="$second_root" happy-terminal daemon start
second_pid="$(read_registered_pid)"
HAPPY_AGENT_WORKSPACES_DIRECTORY="$second_root" node /workspace/workspace-directory-client.mjs verify-change
HAPPY_AGENT_WORKSPACES_DIRECTORY="$second_root" happy-terminal daemon stop
wait_for_exit "$second_pid"

echo "Persisted workspace path remained usable"
echo ${COMPLETED_MARKER}
sleep 60
`;

const workspaceDirectoryClientScript = String.raw`
import { access, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";

const serverDirectory = process.env.HAPPY_TERMINAL_SERVER_DIRECTORY;
const socketPath = process.env.HAPPY_TERMINAL_SERVER_SOCKET_PATH;
const workspaceRoot = process.env.HAPPY_AGENT_WORKSPACES_DIRECTORY;
if (serverDirectory === undefined || socketPath === undefined || workspaceRoot === undefined) {
    throw new Error("Workspace directory test environment is incomplete.");
}
const token = (await readFile(serverDirectory + "/token", "utf8")).trim();

function requestJson(method, path, body, headers = {}) {
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
                    ...headers,
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

async function readyWorkspace(projectId, workspaceId) {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const listing = await requestJson(
            "GET",
            "/projects/" + encodeURIComponent(projectId) + "/workspaces",
        );
        const workspace = listing.workspaces.find((candidate) => candidate.id === workspaceId);
        if (workspace === undefined) throw new Error("The managed workspace disappeared.");
        if (workspace.status !== "initializing") return workspace;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the managed workspace.");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function createWorkspace(projectId, name) {
    const created = await requestJson(
        "POST",
        "/projects/" + encodeURIComponent(projectId) + "/workspaces",
        { baseRef: "HEAD", name },
    );
    const workspace = await readyWorkspace(projectId, created.workspace.id);
    if (workspace.status !== "ready") {
        throw new Error("The managed workspace failed: " + JSON.stringify(workspace));
    }
    return workspace;
}

if (process.argv[2] === "create-old") {
    const session = await requestJson("POST", "/sessions", { cwd: "/workspace" });
    const projectId = session.session.projectId;
    const workspace = await createWorkspace(projectId, "Old Root");
    if (!workspace.path.startsWith(workspaceRoot + "/")) {
        throw new Error("The first workspace ignored its directory override: " + workspace.path);
    }
    await writeFile(
        "/workspace/old-managed-workspace.json",
        JSON.stringify({ id: workspace.id, path: workspace.path, projectId }),
    );
} else if (process.argv[2] === "verify-change") {
    const old = JSON.parse(await readFile("/workspace/old-managed-workspace.json", "utf8"));
    const oldWorkspace = await readyWorkspace(old.projectId, old.id);
    if (oldWorkspace.path !== old.path) {
        throw new Error("The persisted workspace path changed after restart.");
    }
    await access(oldWorkspace.path);

    const created = await createWorkspace(old.projectId, "New Root");
    if (!created.path.startsWith(workspaceRoot + "/")) {
        throw new Error("The new workspace ignored the changed override: " + created.path);
    }

    await requestJson(
        "POST",
        "/projects/" +
            encodeURIComponent(old.projectId) +
            "/workspaces/" +
            encodeURIComponent(old.id) +
            "/archive",
        undefined,
        { "if-match": '"' + oldWorkspace.version + '"' },
    );
    const deadline = Date.now() + 10_000;
    let oldRemoved = false;
    while (Date.now() < deadline) {
        try {
            await access(oldWorkspace.path);
            await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
            oldRemoved = true;
            break;
        }
    }
    await writeFile(
        "/workspace/workspace-directory-change-result.json",
        JSON.stringify({
            newPath: created.path,
            oldPath: oldWorkspace.path,
            oldRemoved,
        }),
    );
} else {
    throw new Error("Unknown workspace directory test phase.");
}
`;
