import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("user configuration initialization", () => {
    it("creates a commented happy.toml and empty global markdown files", async () => {
        const gym = await createGym({
            inference: [{ content: [{ text: "Happy Terminal is ready.", type: "text" }] }],
        });
        running.add(gym);

        const { stdout } = await gym.runInContainer("node", [
            "--input-type=module",
            "--eval",
            verifyGeneratedFilesScript,
        ]);
        expect(stdout).toBe("Generated Happy configuration is valid.\n");

        gym.terminal.type("Confirm the session is ready.");
        gym.terminal.press("enter");

        const snapshot = await gym.terminal.waitForText("Happy Terminal is ready.", 30_000);
        expect(snapshot.text).toContain("Happy Terminal is ready.");
    }, 30_000);

    it("preserves an existing happy.toml while creating global markdown files", async () => {
        const gym = await createGym({
            homeFiles: {
                "Happy/Config/happy.toml": "[settings]\nshow_usage = false\n",
            },
            inference: [{ content: [{ text: "Existing configuration verified.", type: "text" }] }],
        });
        running.add(gym);

        const { stdout } = await gym.runInContainer("node", [
            "--input-type=module",
            "--eval",
            verifyExistingFilesScript,
        ]);
        expect(stdout).toBe("Existing Happy configuration was preserved.\n");

        gym.terminal.type("Verify the existing Happy configuration.");
        gym.terminal.press("enter");

        const snapshot = await gym.terminal.waitForText("Existing configuration verified.", 30_000);
        expect(snapshot.text).toContain("Existing configuration verified.");
    }, 30_000);

    it("keeps the daemon usable when default configuration files cannot be created", async () => {
        const gym = await createGym({
            homeFiles: { happy: "not a directory\n" },
            inference: [{ content: [{ text: "Startup continued.", type: "text" }] }],
        });
        running.add(gym);

        gym.terminal.type("Confirm startup continued.");
        gym.terminal.press("enter");

        const snapshot = await gym.terminal.waitForText("Startup continued.", 30_000);
        expect(snapshot.text).toContain("Startup continued.");
    }, 30_000);
});

const configurationDirectory = "/home/happy-terminal/happy/config";

const verifyGeneratedFilesScript = String.raw`
import { readFile } from "node:fs/promises";

const configuration = ${JSON.stringify(configurationDirectory)};
const template = await readFile(configuration + "/happy.toml", "utf8");
const instructions = await readFile(configuration + "/AGENTS.md", "utf8");
const security = await readFile(configuration + "/SECURITY.md", "utf8");
if (instructions !== "") throw new Error("AGENTS.md must start empty.");
if (security !== "") throw new Error("SECURITY.md must start empty.");
if (template.split("\n").some((line) => line.trim().length > 0 && !line.startsWith("#"))) {
    throw new Error("The generated happy.toml must be fully commented.");
}
process.stdout.write("Generated Happy configuration is valid.\n");
`;

const verifyExistingFilesScript = String.raw`
import { readFile } from "node:fs/promises";

const configuration = ${JSON.stringify(configurationDirectory)};
const config = await readFile(configuration + "/happy.toml", "utf8");
const instructions = await readFile(configuration + "/AGENTS.md", "utf8");
const security = await readFile(configuration + "/SECURITY.md", "utf8");
if (config !== "[settings]\nshow_usage = false\n") {
    throw new Error("The existing happy.toml was replaced.");
}
if (instructions !== "") throw new Error("AGENTS.md must start empty.");
if (security !== "") throw new Error("SECURITY.md must start empty.");
process.stdout.write("Existing Happy configuration was preserved.\n");
`;
