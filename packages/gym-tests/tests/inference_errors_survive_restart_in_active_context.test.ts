import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const RETRY_ERROR = "DURABLE_RETRY_CONNECTION_LOST";
const TERMINAL_ERROR = "DURABLE_TERMINAL_PROVIDER_FAILURE";
const RESUME_MARKER = "DURABLE_INFERENCE_ERRORS_RESUME_BOUNDARY";
const RECOVERED = "DURABLE_INFERENCE_ERRORS_RECOVERED";
const PROVIDER_ERROR = {
    diagnostics: {
        attempts: 3,
        code: "model_backend_failure",
        errorType: "server_error",
        requestId: "request-durable-1",
        responseId: "response-durable-1",
        retryDirective: false,
        status: 502,
        upstreamMessage: TERMINAL_ERROR,
    },
    type: "internal_server_error",
} as const;

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("durable inference errors", () => {
    it("restores retries and terminal failures into history and the next model context", async () => {
        const gym = await createGym({
            entrypoint: [
                "bash",
                "-lc",
                [
                    "node /app/packages/rig/dist/main.js",
                    "node /app/packages/rig/dist/main.js daemon stop",
                    "node /workspace/inspect-inference-errors.mjs",
                    `echo ${RESUME_MARKER}`,
                    "exec node /app/packages/rig/dist/main.js resume --last",
                ].join("; "),
            ],
            files: {
                "inspect-inference-errors.mjs": inspectInferenceErrorsScript,
            },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [],
                        errorMessage: TERMINAL_ERROR,
                        providerRetries: [
                            {
                                attempt: 2,
                                delayMs: 10,
                                reason: RETRY_ERROR,
                            },
                        ],
                        providerError: PROVIDER_ERROR,
                        stopReason: "error",
                    };
                }
                expect(callIndex).toBe(1);
                const context = JSON.stringify(request.context.messages);
                expect(context).toContain(RETRY_ERROR);
                expect(context).toContain(TERMINAL_ERROR);
                expect(context).toContain("failed and was retried");
                expect(context).toContain("previous work stopped with an error");
                return { content: [{ text: RECOVERED, type: "text" }] };
            },
            mode: "docker",
            timeoutMs: 60_000,
        });
        running.add(gym);

        submit(gym, "Fail once, then preserve every inference failure.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes(TERMINAL_ERROR) &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the terminal provider failure",
            30_000,
        );

        gym.terminal.press("ctrlD");
        const resumed = await gym.terminal.waitUntil(
            (snapshot) => {
                const marker = snapshot.text.indexOf(RESUME_MARKER);
                if (marker < 0) return false;
                const text = snapshot.text.slice(marker);
                return (
                    text.includes(RETRY_ERROR) &&
                    text.includes(TERMINAL_ERROR) &&
                    text.includes("Ask Rig to do anything")
                );
            },
            "both durable errors after restart",
            30_000,
        );
        expect(resumed.text).toContain(RESUME_MARKER);

        const persisted = JSON.parse(await gym.readFile("inference-errors-persistence.json")) as {
            contextErrors: number;
            durableErrorEvents: number;
            obsoleteRetryEvents: number;
            terminalEventProviderError: typeof PROVIDER_ERROR;
            terminalMessageProviderError: typeof PROVIDER_ERROR;
            terminalProviderId: string;
            terminalRequestedModelId: string;
            transcriptErrors: number;
        };
        expect(persisted).toEqual({
            contextErrors: 2,
            durableErrorEvents: 2,
            obsoleteRetryEvents: 0,
            terminalEventProviderError: PROVIDER_ERROR,
            terminalMessageProviderError: PROVIDER_ERROR,
            terminalProviderId: "gym",
            terminalRequestedModelId: "openai/gym",
            transcriptErrors: 2,
        });

        submit(gym, "Continue with the durable failures in context.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes(RECOVERED) &&
                snapshot.text.includes("Ask Rig to do anything"),
            "a successful inference using restored error context",
            30_000,
        );
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

const inspectInferenceErrorsScript = String.raw`
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync("/home/rig/.happy/rig/sessions.sqlite", { readOnly: true });
const sessionId = database
    .prepare("SELECT id FROM sessions WHERE parent_session_id IS NULL ORDER BY created_at_ms DESC LIMIT 1")
    .get().id;
const transcriptErrors = database
    .prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND role = 'error'")
    .get(sessionId).count;
const contextErrors = database
    .prepare("SELECT COUNT(*) AS count FROM session_context_messages WHERE session_id = ? AND role = 'error'")
    .get(sessionId).count;
const durableEvents = database
    .prepare("SELECT type, data_json FROM session_events WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
const durableErrorEvents = durableEvents.filter((event) => {
    if (event.type !== "agent_message") return false;
    return JSON.parse(event.data_json).message?.role === "error";
}).length;
const obsoleteRetryEvents = durableEvents.filter((event) => event.type === "inference_retry").length;
const terminalMessage = JSON.parse(
    database
        .prepare(
            "SELECT message_json FROM session_messages WHERE session_id = ? AND role = 'error' ORDER BY position DESC LIMIT 1",
        )
        .get(sessionId).message_json,
);
const terminalEvent = durableEvents
    .filter((event) => event.type === "run_finished")
    .map((event) => JSON.parse(event.data_json))
    .find((data) => data.stopReason === "error");
const sessionColumns = database
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .map((column) => column.name);
if (sessionColumns.includes("context_messages_json")) {
    throw new Error("The obsolete sessions context column still exists.");
}
database.close();
writeFileSync(
    "/workspace/inference-errors-persistence.json",
    JSON.stringify({
        contextErrors,
        durableErrorEvents,
        obsoleteRetryEvents,
        terminalEventProviderError: terminalEvent.providerError,
        terminalMessageProviderError: terminalMessage.providerError,
        terminalProviderId: terminalMessage.providerId,
        terminalRequestedModelId: terminalMessage.requestedModelId,
        transcriptErrors,
    }),
);
`;
