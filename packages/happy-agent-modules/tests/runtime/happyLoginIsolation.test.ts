import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders } from "@slopus/happy-agent-base";
import { afterEach, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

/** Stands in for the developer's real home, where a signed-in Happy CLI keeps its login. */
const home = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:os", async (original) => {
    const os = await original<typeof import("node:os")>();
    return { ...os, homedir: () => home.directory || os.homedir() };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Test daemons with temporary roots adopted the developer's `~/.happy/access.key`, registered
 * hundreds of machines on their real account and published a Chief of Staff session from each.
 * A runtime started on any root other than the real one must not read that login, even with no
 * `HAPPY_HOME_DIR` in sight.
 */
it("never adopts the Happy CLI login of the real home for a runtime on another root", async () => {
    const root = await mkdtemp(join(tmpdir(), "happy-login-isolation-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    home.directory = join(root, "real-home");
    cleanups.push(async () => {
        home.directory = "";
    });
    const realLogin = join(home.directory, ".happy");
    await mkdir(realLogin, { recursive: true });
    await writeFile(
        join(realLogin, "access.key"),
        JSON.stringify({ secret: Buffer.alloc(32, 7).toString("base64"), token: "real-login" }),
    );
    // Unreachable, so even a regression cannot publish anywhere.
    await writeFile(
        join(realLogin, "settings.json"),
        JSON.stringify({ serverUrl: "http://127.0.0.1:9" }),
    );
    expect(process.env.HAPPY_HOME_DIR).toBeUndefined();

    const happyHome = join(root, "test-root", ".happy");
    const config = await ConfigModule.load(happyHome);
    expect(config.happyEnvironment.HAPPY_HOME_DIR).toBe(config.configuration.paths.happyHome);
    config.closeProviders();

    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider([]), "codex");
    const runtime: HappyAgentRuntime = await startHappyAgentRuntime({
        happyHome,
        inference: {
            models: [
                {
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                    id: "gym/model",
                    name: "Gym",
                    providerId: "gym",
                },
            ],
            providers,
        },
    });
    cleanups.push(async () => await runtime.close());

    expect(await runtime.modules.happy.integration(runtime.ctx)).toMatchObject({
        configured: false,
    });
    for (const file of ["access.key", "settings.json", "machine.json"]) {
        await expect(access(join(happyHome, "agent", "happy", file))).rejects.toMatchObject({
            code: "ENOENT",
        });
    }
}, 30_000);
