import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { libsqlCommonJsScript } from "./libsqlScript.js";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Happy configuration", () => {
    it("keeps synchronization disabled when the global config turns it off", async () => {
        const gym = await createGym({
            homeFiles: {
                ".happy/access.key": JSON.stringify({
                    secret: Buffer.alloc(32, 7).toString("base64"),
                    token: "happy-gym-token",
                }),
                "Happy/Config/happy.toml": "[settings]\nhappy_integration = false\n",
            },
            inference: [
                {
                    content: [{ text: "Local-only session completed.", type: "text" }],
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Work without Happy synchronization.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Local-only session completed.", 30_000);

        const inspection = await gym.runInContainer("node", [
            "-e",
            libsqlCommonJsScript(`
const fs = require("node:fs");
const database = await openDatabase("/home/happy-terminal/.happy/agent/agent.sqlite", true);
let sessions = 0;
try {
    sessions = (
        await database.execute("select count(*) as count from happy_agent_happy_sessions")
    ).rows[0].count;
} catch {
    // Synchronization that never started leaves no happy tables at all.
} finally {
    await database.close();
}
const copied = fs.existsSync("/home/happy-terminal/.happy/agent/happy/access.key");
process.stdout.write(JSON.stringify({ copied, sessions }));
`),
        ]);

        expect(JSON.parse(inspection.stdout)).toEqual({ copied: false, sessions: 0 });
    }, 120_000);
});
