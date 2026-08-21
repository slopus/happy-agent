import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * Talks to the running daemon the way another terminal or an external client
 * would: over the local server socket, with the daemon's bearer token.
 */
const CLIENT_SCRIPT = `
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");

const directory = join(process.env.HOME, ".happy", "agent");
const token = readFileSync(join(directory, "token"), "utf8").trim();
const socketPath = join(directory, "server.sock");

function call(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { authorization: "Bearer " + token };
        if (payload !== undefined) {
            headers["content-type"] = "application/json";
            headers["content-length"] = Buffer.byteLength(payload);
        }
        const outgoing = request({ headers, method, path, socketPath }, (response) => {
            let data = "";
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => {
                if (response.statusCode >= 400) {
                    reject(new Error("HTTP " + response.statusCode + ": " + data));
                    return;
                }
                resolve(data.length === 0 ? {} : JSON.parse(data));
            });
        });
        outgoing.on("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}

(async () => {
    const bootstrap = await call("GET", "/v0/bootstrap/desktop");
    const agents = bootstrap.workspaces.flatMap((workspace) => workspace.agents ?? []);
    const agentId = agents[0].id;
    if (process.argv[1] === "write") {
        await call("PUT", "/v0/agents/" + agentId + "/draft", {
            draft: {
                text: process.argv[2],
                providerId: "gym",
                modelId: "openai/gym",
                effort: "off",
                serviceTier: null,
                permissionMode: "full_access",
            },
            updatedAt: Date.now(),
        });
        process.stdout.write("written");
        return;
    }
    const agent = await call("GET", "/v0/agents/" + agentId);
    const draft = agent.agent.draft;
    process.stdout.write(JSON.stringify(draft === null || draft === undefined ? "" : draft.text));
})().catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(1);
});
`;

async function readStoredDraft(gym: Gym): Promise<string> {
    const { stdout } = await gym.runInContainer("node", ["-e", CLIENT_SCRIPT, "read"]);
    return JSON.parse(stdout) as string;
}

async function waitForStoredDraft(gym: Gym, expected: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stored = await readStoredDraft(gym);
    while (stored !== expected) {
        if (Date.now() >= deadline) {
            throw new Error(
                `Timed out waiting for the daemon to hold ${JSON.stringify(expected)}. It holds ${JSON.stringify(stored)}.`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        stored = await readStoredDraft(gym);
    }
}

async function writeDraftFromAnotherClient(gym: Gym, draft: string): Promise<void> {
    await gym.runInContainer("node", ["-e", CLIENT_SCRIPT, "write", draft]);
}

describe("composer draft syncs between clients", () => {
    it("stores what the user typed and follows a draft written elsewhere", async () => {
        const gym = await createGym({
            inference: [{ content: [{ text: "Not needed for this scenario.", type: "text" }] }],
        });
        running.add(gym);

        gym.terminal.type("Refactor the parser");
        await gym.terminal.waitForText("Refactor the parser");

        // The unsent message reaches the daemon, so another terminal opening
        // this session picks the message back up.
        await waitForStoredDraft(gym, "Refactor the parser");

        await writeDraftFromAnotherClient(gym, "Written from another client");

        const screen = await gym.terminal.waitForText("Written from another client", 10_000);
        expect(screen.text).not.toContain("Refactor the parser");
    });
});
