import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { libsqlEsmScript } from "./libsqlScript.js";

const running = new Set<Gym>();
const PENDING_MESSAGE = "Preserve this direction after the provider error.";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("pending steering after a provider error", () => {
    it("commits externally submitted steering before the failed run finishes", async () => {
        const releaseInference = deferred<void>();
        let inferenceStarted = false;
        const gym = await createGym({
            mode: "docker",
            files: { "provider-error-steering.mjs": providerErrorSteeringScript },
            async inference(_request, callIndex) {
                expect(callIndex).toBe(0);
                inferenceStarted = true;
                await releaseInference.promise;
                return {
                    content: [],
                    errorMessage: "EXPECTED_PROVIDER_STEERING_ERROR",
                    stopReason: "error",
                };
            },
        });
        running.add(gym);

        submit(gym, "Keep this inference active while another client sends direction.");
        await gym.terminal.waitUntil(
            (snapshot) => inferenceStarted && snapshot.text.includes("esc to interrupt"),
            "the provider request to remain active",
            30_000,
        );

        const steered = await gym.runInContainer("node", [
            "/workspace/provider-error-steering.mjs",
            "steer",
            PENDING_MESSAGE,
        ]);
        expect(steered.stderr).toBe("");
        expect(steered.stdout.trim()).toBe("steered");

        releaseInference.resolve();
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("EXPECTED_PROVIDER_STEERING_ERROR") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the provider error to finish the run",
            30_000,
        );

        const inspected = await gym.runInContainer("node", [
            "/workspace/provider-error-steering.mjs",
            "inspect",
            PENDING_MESSAGE,
        ]);
        expect(inspected.stderr).toBe("");
        expect(JSON.parse(inspected.stdout)).toMatchObject({
            appliedCount: 1,
            finishedStopReason: "error",
            storedCount: 1,
            submittedCount: 1,
        });
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value as T),
    };
}

const providerErrorSteeringScript = libsqlEsmScript(
    String.raw`
const action = process.argv[2];
const message = process.argv[3];
const directory = "/tmp/rig-" + process.getuid();

if (action === "steer") {
    const socketPath = directory + "/server.sock";
    const token = (await readFile(directory + "/token", "utf8")).trim();
    const sessions = await requestJson(socketPath, token, "GET", "/sessions");
    const active = sessions.sessions.find((session) => session.status === "running");
    if (active === undefined) throw new Error("No running session found.");
    await requestJson(
        socketPath,
        token,
        "POST",
        "/sessions/" + encodeURIComponent(active.id) + "/steer",
        { text: message },
    );
    process.stdout.write("steered\n");
} else if (action === "inspect") {
    const database = await openDatabase("/home/happy-terminal/.happy/rig/sessions.sqlite");
    let output;
    try {
    const sessionId = (
        await database.execute(
            "SELECT id FROM sessions WHERE parent_session_id IS NULL ORDER BY created_at_ms DESC LIMIT 1",
        )
    ).rows[0].id;
    const events = (
        await database.execute({
            sql: "SELECT seq, type, data_json FROM session_events WHERE session_id = ? ORDER BY seq",
            args: [sessionId],
        })
    ).rows
        .map((event) => ({ ...event, data: JSON.parse(event.data_json) }));
    const submitted = events.filter(
        (event) =>
            event.type === "message_submitted" &&
            event.data.delivery === "steer" &&
            event.data.displayText === message,
    );
    const messageId = submitted[0]?.data.message.id;
    const applied = events.filter(
        (event) =>
            event.type === "steering_applied" &&
            messageId !== undefined &&
            event.data.messageIds.includes(messageId),
    );
    const finished = events.find(
        (event) =>
            event.type === "run_finished" &&
            submitted[0] !== undefined &&
            event.data.runId === submitted[0].data.runId,
    );
    const storedCount =
        messageId === undefined
            ? 0
            : (
                  await database.execute({
                      sql: "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                      args: [sessionId, messageId],
                  })
              ).rows[0].count;
    output = {
        appliedCount: applied.length,
        finishedStopReason: finished?.data.stopReason,
        storedCount,
        submittedCount: submitted.length,
    };
    } finally {
        await database.close();
    }
    process.stdout.write(
        JSON.stringify(output),
    );
} else {
    throw new Error("Unknown action: " + action);
}

function requestJson(socketPath, token, method, path, body) {
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
`,
    'import { readFile } from "node:fs/promises"; import { request } from "node:http";',
);
