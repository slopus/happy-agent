import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("live model catalog", () => {
    it("reconciles provider enablement changes in an already-open terminal", async () => {
        const gym = await createGym({
            homeFiles: {
                "Happy/Config/happy.toml": "[providers.claude]\nenabled = true\n",
            },
            inference: [
                { content: [{ text: "DISABLED_CATALOG_BARRIER", type: "text" }] },
                { content: [{ text: "ENABLED_CATALOG_BARRIER", type: "text" }] },
            ],
        });
        running.add(gym);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const initial = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(initial.text).toContain("Sonnet 5");
        gym.terminal.press("escape");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

        await setProviderEnabled(gym, "claude", false);
        gym.terminal.type("Observe the disabled catalog event.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("DISABLED_CATALOG_BARRIER", 30_000);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const disabled = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(disabled.text).not.toContain("Sonnet 5");
        gym.terminal.press("escape");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

        await setProviderEnabled(gym, "claude", true);
        gym.terminal.type("Observe the enabled catalog event.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("ENABLED_CATALOG_BARRIER", 30_000);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const enabled = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(enabled.text).toContain("Sonnet 5");
    }, 60_000);
});

async function setProviderEnabled(gym: Gym, providerId: string, enabled: boolean): Promise<void> {
    const clientEntry = pathToFileURL(
        resolve(
            import.meta.dirname,
            "../../happy-agent/node_modules/@slopus/happy-agent-client/dist/index.js",
        ),
    ).href;
    const socketFetchEntry = pathToFileURL(
        resolve(
            import.meta.dirname,
            "../../happy-terminal/sources/daemon/createUnixSocketFetch.ts",
        ),
    ).href;
    const script = `
        import { readFile } from "node:fs/promises";
        import { join } from "node:path";
        import { HappyAgentClient } from ${JSON.stringify(clientEntry)};
        import { createUnixSocketFetch } from ${JSON.stringify(socketFetchEntry)};

        const agentDirectory = join(process.env.HOME, ".happy", "agent");
        const token = (await readFile(join(agentDirectory, "token"), "utf8")).trim();
        const client = new HappyAgentClient({
            endpoint: "http://happy",
            fetch: createUnixSocketFetch(join(agentDirectory, "server.sock")),
            token,
        });
        await client.patchConfig({ providers: { ${JSON.stringify(providerId)}: { enabled: ${JSON.stringify(enabled)} } } });
    `;
    await gym.runInContainer(process.execPath, ["--input-type=module", "--eval", script]);
}
