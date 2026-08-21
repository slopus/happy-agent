import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { libsqlEsmScript } from "./libsqlScript.js";

const artifacts = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/clean-features",
);
const running = new Set<Gym>();
const RESUME_MARKER = "STREAMED_SESSION_RESUME_BOUNDARY";
const FIRST_RESPONSE = `STREAMED_HISTORY_START\n${"streamed history ".repeat(64)}\nSTREAMED_HISTORY_COMPLETE`;
const MAX_PERSISTED_EVENT_ROWS = 16;

beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("resuming a session with streamed response history", () => {
    it("keeps transient inference events out of durable storage and resumes the transcript", async () => {
        const gym = await createGym({
            cols: 96,
            mode: "docker",
            entrypoint: [
                "bash",
                "-lc",
                [
                    "node /app/packages/happy-terminal/dist/main.js",
                    "node /app/packages/happy-terminal/dist/main.js daemon stop",
                    "node /workspace/inspect-streamed-session.mjs",
                    `echo ${RESUME_MARKER}`,
                    "exec node /app/packages/happy-terminal/dist/main.js resume --last",
                ].join("; "),
            ],
            files: {
                "inspect-streamed-session.mjs": inspectStreamedSessionScript,
            },
            environment: {
                NO_PROXY: "host.docker.internal",
                HAPPY_TERMINAL_CODEX_BASE_URL: "{{HTTP_PROXY_URL}}/backend-api",
            },
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "bounded-session-token",
                        account_id: "bounded-session",
                    },
                }),
            },
            httpProxy: {
                handler(request) {
                    if (new URL(request.url).pathname === "/backend-api/wham/usage") {
                        return {
                            response: {
                                body: JSON.stringify({
                                    rate_limit: {
                                        primary_window: {
                                            limit_window_seconds: 18_000,
                                            reset_at: Math.floor(Date.now() / 1_000) + 3_600,
                                            used_percent: 20,
                                        },
                                        secondary_window: {
                                            limit_window_seconds: 604_800,
                                            reset_at: Math.floor(Date.now() / 1_000) + 345_600,
                                            used_percent: 10,
                                        },
                                    },
                                }),
                                headers: { "content-type": "application/json" },
                                status: 200,
                            },
                        };
                    }
                    return { response: { body: "Unexpected quota request", status: 404 } };
                },
            },
            inference(_request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: FIRST_RESPONSE, type: "text" }],
                        textDeltaChunkSize: 1,
                    };
                }
                expect(callIndex).toBe(1);
                return { content: [{ text: "FOLLOW_UP_AFTER_RESUME", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 60,
        });
        running.add(gym);

        submit(gym, "Stream a response, then let me resume this session.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("STREAMED_HISTORY_COMPLETE") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the streamed response to complete",
            30_000,
        );

        gym.terminal.press("ctrlD");
        const resumed = await gym.terminal.waitUntil(
            (snapshot) => {
                const marker = snapshot.text.indexOf(RESUME_MARKER);
                if (marker < 0) return false;
                const resumedText = snapshot.text.slice(marker);
                return (
                    resumedText.includes("STREAMED_HISTORY_COMPLETE") &&
                    resumedText.includes("Ask Happy Terminal to do anything")
                );
            },
            "the streamed transcript after daemon restart",
            30_000,
        );
        expect(resumed.text.slice(resumed.text.indexOf(RESUME_MARKER))).toContain(
            "STREAMED_HISTORY_START",
        );

        const persistedJson = await gym.readFile("streamed-session-persistence.json");
        const persisted = JSON.parse(persistedJson) as {
            persistedEventRows: number;
            transientInferenceEvents: number;
        };
        expect(persisted.transientInferenceEvents).toBe(0);
        expect(persisted.persistedEventRows).toBeGreaterThan(0);
        expect(persisted.persistedEventRows).toBeLessThanOrEqual(MAX_PERSISTED_EVENT_ROWS);

        submit(gym, "Confirm this resumed session still works.");
        const healthy = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("FOLLOW_UP_AFTER_RESUME") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "a completed turn after resume",
            30_000,
        );
        expect(healthy.cursor.x).toBeLessThan(96);
        expect(healthy.cursor.y).toBeLessThan(60);

        await writeFile(`${artifacts}/persistence.json`, `${persistedJson}\n`);
        await gym.terminal.screenshot(`${artifacts}/healthy-resume.png`);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

const inspectStreamedSessionScript = libsqlEsmScript(
    `
const transientTypes = new Set([
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
    "error",
]);
const database = await openDatabase("/home/happy-terminal/.happy/rig/sessions.sqlite", true);
let result;
try {
const sessionId = (
    await database.execute(
        "SELECT id FROM sessions WHERE parent_session_id IS NULL ORDER BY created_at_ms DESC LIMIT 1",
    )
).rows[0].id;
const rows = (
    await database.execute({
        sql: "SELECT type, data_json FROM session_events WHERE session_id = ? ORDER BY seq",
        args: [sessionId],
    })
).rows;
let transientInferenceEvents = 0;
for (const row of rows) {
    if (row.type !== "agent_event") continue;
    const event = JSON.parse(row.data_json).event;
    if (transientTypes.has(event?.type)) transientInferenceEvents += 1;
}
result = { persistedEventRows: rows.length, transientInferenceEvents };
} finally {
    await database.close();
}
writeFileSync(
    "/workspace/streamed-session-persistence.json",
    JSON.stringify(result),
);
`,
    'import { writeFileSync } from "node:fs";',
);
