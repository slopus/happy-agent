import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { libsqlCommonJsScript } from "./libsqlScript.js";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Happy mobile synchronization", () => {
    it("imports Happy credentials and durably queues an open session while offline", async () => {
        const credentials = {
            secret: Buffer.alloc(32, 7).toString("base64"),
            token: "happy-gym-token",
        };
        const gym = await createGym({
            homeFiles: {
                ".happy/access.key": JSON.stringify(credentials),
                ".happy/settings.json": JSON.stringify({ serverUrl: "http://127.0.0.1:9" }),
            },
            inference: [
                {
                    content: [
                        {
                            text: "Local work continued while Happy was offline.",
                            type: "text",
                        },
                    ],
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Keep working even if mobile sync is unavailable.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("Local work continued while Happy was offline.", 30_000);
        const inspection = await gym.runInContainer("node", [
            "-e",
            libsqlCommonJsScript(`
const fs = require("node:fs");
const copied = JSON.parse(
    fs.readFileSync("/home/happy-terminal/.happy/agent/happy/access.key", "utf8"),
);
const mode = fs.statSync("/home/happy-terminal/.happy/agent/happy/access.key").mode & 0o777;
const database = await openDatabase("/home/happy-terminal/.happy/agent/agent.sqlite", true);
let sessions;
let outbox;
try {
    sessions = (
        await database.execute("select count(*) as count from happy_agent_happy_sessions")
    ).rows[0].count;
    outbox = (
        await database.execute("select count(*) as count from happy_agent_happy_outbox")
    ).rows[0].count;
} finally {
    await database.close();
}
process.stdout.write(JSON.stringify({ copied, mode, sessions, outbox }));
`),
        ]);
        const state = JSON.parse(inspection.stdout) as {
            copied: typeof credentials;
            mode: number;
            outbox: number;
            sessions: number;
        };

        expect(state.copied).toEqual(credentials);
        expect(state.mode).toBe(0o600);
        expect(state.sessions).toBe(1);
        expect(state.outbox).toBeGreaterThan(0);
    }, 120_000);
});
