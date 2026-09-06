import { expect, it } from "vitest";

import { createGym } from "@slopus/happy-terminal-gym";

it("loads the fixed API token and initializes configuration in lowercase on Linux", async () => {
    const gym = await createGym({
        mode: "docker",
        homeFiles: {
            "happy/config/happy.toml": `[api]\ntoken = "${"t".repeat(43)}"\n`,
        },
        inference: [{ content: [{ text: "Linux configuration loaded.", type: "text" }] }],
    });
    try {
        gym.terminal.type("Confirm startup.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Linux configuration loaded.");
        const { stdout } = await gym.runInContainer("node", [
            "--input-type=module",
            "--eval",
            `import assert from "node:assert/strict";
             import { readFile, readdir } from "node:fs/promises";
             import { homedir } from "node:os";
             const home = homedir();
             assert.equal((await readFile(home + "/.happy/agent/token", "utf8")).trim(), "t".repeat(43));
             assert.deepEqual((await readdir(home + "/happy/config")).sort(), ["AGENTS.md", "SECURITY.md", "happy.toml", "mcp.toml"]);
             assert.equal((await readdir(home)).includes("Happy"), false);
             console.log("Lowercase configuration verified.");`,
        ]);
        expect(stdout).toBe("Lowercase configuration verified.\n");
    } finally {
        await gym.dispose();
    }
}, 60_000);
