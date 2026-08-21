import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("external reset boundary", () => {
    it("discards local queued execution into history and accepts only fresh work", async () => {
        const queued = "Do not run this queued pre-reset prompt.";
        const draft = "Preserve this draft across external reset.";
        const fresh = "Run only this fresh post-reset prompt.";
        const gym = await createGym({
            mode: "docker",
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: "UNREACHABLE_PRE_RESET_RESPONSE", type: "text" }],
                        delayMs: 60_000,
                    };
                }
                expect(callIndex).toBe(1);
                const texts = request.context.messages.flatMap((message) =>
                    message.role === "user" ? [messageText(message.content)] : [],
                );
                expect(texts).toContain(fresh);
                expect(texts).not.toContain(queued);
                return { content: [{ text: "FRESH_POST_RESET_RESPONSE", type: "text" }] };
            },
            rows: 38,
        });
        running.add(gym);

        submit(gym, "Start active work before reset.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        gym.terminal.type(queued);
        await waitForComposer(gym, queued);
        gym.terminal.press("tab");
        await gym.terminal.waitForText(`↳ queued ${queued}`, 30_000);
        gym.terminal.type(draft);

        const reset = await gym.runInContainer("node", ["-e", resetActiveSessionScript]);
        expect(reset.stderr).toBe("");
        expect(reset.stdout).toContain("reset\n");

        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session reset. Started a new session") &&
                snapshot.text.includes(draft) &&
                !snapshot.text.includes("↳ queued") &&
                !snapshot.text.includes("UNREACHABLE_PRE_RESET_RESPONSE") &&
                !snapshot.text.includes("esc to interrupt"),
            "external reset to become an idle transcript boundary",
            30_000,
        );
        expect(agentRequests(gym)).toHaveLength(1);

        gym.terminal.press("ctrlC");
        gym.terminal.press("up");
        await gym.terminal.waitForText(queued, 30_000);
        gym.terminal.press("ctrlC");
        submit(gym, fresh);
        await gym.terminal.waitForText("FRESH_POST_RESET_RESPONSE", 30_000);
        expect(agentRequests(gym)).toHaveLength(2);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

async function waitForComposer(gym: Gym, text: string) {
    return gym.terminal.waitUntil(
        (snapshot) => composerText(snapshot) === text,
        `composer text ${JSON.stringify(text)}`,
        30_000,
    );
}

function composerText(snapshot: { rows: readonly string[] }): string | undefined {
    const footer = snapshot.rows.findIndex((row) => row.includes("gym off · /workspace"));
    const row = footer >= 2 ? snapshot.rows[footer - 2] : undefined;
    return row?.replace(/^\s*›\s?/u, "").trimEnd();
}

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (block): block is { text: string } =>
                typeof block === "object" &&
                block !== null &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
}

const resetActiveSessionScript = String.raw`
const { readFile } = require("node:fs/promises");
const { request } = require("node:http");

(async () => {
    const directory = "/tmp/rig-" + process.getuid();
    const socketPath = directory + "/server.sock";
    const token = (await readFile(directory + "/token", "utf8")).trim();
    const requestJson = (method, path) => new Promise((resolve, reject) => {
        const outgoing = request({
            socketPath,
            path,
            method,
            headers: { authorization: "Bearer " + token, accept: "application/json" },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if ((response.statusCode ?? 500) >= 400) reject(new Error(text));
                else resolve(text.length === 0 ? {} : JSON.parse(text));
            });
        });
        outgoing.on("error", reject);
        outgoing.end();
    });
    const sessions = await requestJson("GET", "/sessions");
    const active = sessions.sessions.find((session) => session.status === "running");
    if (active === undefined) throw new Error("No running session found.");
    await requestJson("POST", "/sessions/" + encodeURIComponent(active.id) + "/reset");
    process.stdout.write("reset\n");
})().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
});
`;
