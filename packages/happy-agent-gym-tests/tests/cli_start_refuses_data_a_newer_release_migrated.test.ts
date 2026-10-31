import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createGymHome, recordGymMigration, type GymHome } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * An older Happy Agent started on data a newer release migrated, as happens after a switch from
 * the preview channel to stable or a pulled release: the real CLI, crash supervisor, and daemon
 * as separate processes in a throwaway Happy home. The refusal must be one clean failure with its
 * own exit status, never a daemon the supervisor restarts over and over.
 *
 * The executable is `HAPPY_AGENT_RELOAD_GYM_BINARY` when set, else the locally compiled binary
 * (`pnpm --filter @slopus/happy-agent build:bun`) when present, else the built CLI on the gym's
 * runtime.
 */
const PACKAGE = resolve(import.meta.dirname, "../../happy-agent");
const COMPILED = join(PACKAGE, "dist", "bin", `happy-agent-${process.platform}-${process.arch}`);
const COMMAND: readonly string[] =
    process.env.HAPPY_AGENT_RELOAD_GYM_BINARY !== undefined
        ? [resolve(process.env.HAPPY_AGENT_RELOAD_GYM_BINARY)]
        : existsSync(COMPILED)
          ? [COMPILED]
          : [process.execPath, join(PACKAGE, "dist", "cli.js")];

/** `EX_DATAERR`: the daemon refused data a newer release wrote. */
const NEWER_DATA_EXIT_CODE = 65;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
}, 60_000);

describe.skipIf(process.platform === "win32")("happy-agent start on newer data", () => {
    it("refuses data a newer release migrated with its own exit status and no restart", async () => {
        const world = await installation();
        expect((await world.cli(["start"])).code).toBe(0);
        // This release opened the data, so it is the oldest one that may open it again.
        expect(await world.dataVersion()).toMatchObject({ version: 1, minimumVersion: "0.0.0" });
        expect((await world.cli(["stop"])).code).toBe(0);

        // A newer release added a migration to a module this build knows, and stamped itself.
        await recordGymMigration(world.home.happyHome, {
            module: "surfaces",
            key: "999-written-by-a-newer-release",
        });
        await writeFile(
            world.dataVersionPath,
            JSON.stringify({
                version: 1,
                writtenBy: "99.0.0",
                minimumVersion: "99.0.0",
                updatedAt: new Date().toISOString(),
            }),
            { mode: 0o600 },
        );

        const started = Date.now();
        const refused = await world.cli(["start"]);

        expect(refused.code).toBe(NEWER_DATA_EXIT_CODE);
        expect(refused.output).toContain(
            "This data was written by a newer Happy Agent (version 99.0.0); update to continue.",
        );
        // It failed at once rather than waiting out restarts or the startup deadline.
        expect(Date.now() - started).toBeLessThan(45_000);
        expect(await world.supervisorState()).toMatchObject({
            phase: "refused",
            restarts: 0,
            writtenBy: "99.0.0",
            minimumVersion: "99.0.0",
            lastExit: { code: NEWER_DATA_EXIT_CODE, signal: null },
        });
        const log = await readFile(join(world.home.happyHome, "agent", "daemon.log"), "utf8");
        expect(log).toContain("it will not be restarted until Happy Agent is updated");
        expect(log).not.toContain("restarting in");

        const status = await world.cli(["status"]);
        expect(status.output).toContain("Daemon is not running.");
        expect(status.output).toContain(
            "This data was written by a newer Happy Agent (version 99.0.0); update to continue.",
        );
        // The refusal changed nothing: the data still says who wrote it.
        expect(await world.dataVersion()).toMatchObject({ writtenBy: "99.0.0" });
    }, 120_000);

    it("keeps starting when only a module this release does not have migrated further", async () => {
        const world = await installation();
        expect((await world.cli(["start"])).code).toBe(0);
        expect((await world.cli(["stop"])).code).toBe(0);

        await recordGymMigration(world.home.happyHome, {
            module: "a-module-only-a-newer-release-has",
            key: "001-its-own-table",
        });

        const restarted = await world.cli(["start"]);
        expect(restarted.output).not.toContain("newer Happy Agent");
        expect(restarted.code).toBe(0);
    }, 120_000);
});

/** One isolated installation with the CLI pointed at it. */
async function installation() {
    const home = await createGymHome();
    cleanups.push(async () => await home.remove());
    await mkdir(join(home.root, "home"));
    await mkdir(join(home.root, "claude"));
    await writeFile(
        join(
            home.publicHomePath,
            process.platform === "darwin" ? "Config" : "config",
            "happy.toml",
        ),
        [
            "[providers]",
            "default_enable = false",
            "",
            "[providers.claude]",
            "enabled = true",
            `config_dir = ${JSON.stringify(join(home.root, "claude"))}`,
            'include_models = ["anthropic/opus-5"]',
            "",
        ].join("\n"),
    );
    const environment = isolatedEnvironment(home);
    const cli = (args: readonly string[]) => runCli(args, environment);
    // Stop exactly this home's daemon, whatever state a failed scenario left it in.
    cleanups.push(async () => {
        await cli(["kill"]);
    });
    const dataVersionPath = join(home.happyHome, "agent", "data-version.json");
    const readJson = async (path: string): Promise<unknown> => {
        try {
            return JSON.parse(await readFile(path, "utf8")) as unknown;
        } catch {
            return undefined;
        }
    };
    return {
        cli,
        dataVersion: () => readJson(dataVersionPath),
        dataVersionPath,
        home,
        supervisorState: () => readJson(join(home.happyHome, "agent", "supervisor.json")),
    };
}

function isolatedEnvironment(home: GymHome): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        // Nothing that names another installation or a real account reaches the CLI.
        if (/^(HAPPY_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|XAI_|GROK_)/u.test(key)) continue;
        environment[key] = value;
    }
    return {
        ...environment,
        GIT_CEILING_DIRECTORIES: resolve(home.root, "..", ".."),
        HAPPY_AGENT_PROJECTS_DIRECTORY: join(home.root, "projects"),
        HAPPY_AGENT_WORKSPACES_DIRECTORY: join(home.root, "workspaces"),
        // Nothing here runs inference; the seam only keeps real accounts out of reach.
        HAPPY_GYM_INFERENCE_URL: "http://127.0.0.1:9/unused",
        HAPPY_GYM_TOKEN: "unused",
        HAPPY_HOME_DIR: home.happyHome,
        HOME: join(home.root, "home"),
    };
}

function runCli(
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly output: string }> {
    const home = environment.HAPPY_HOME_DIR;
    if (home === undefined || home === resolve(process.env.HOME ?? "", ".happy")) {
        throw new Error("This gym only runs the CLI against its own throwaway home.");
    }
    return new Promise((done, fail) => {
        const [executable, ...prefix] = COMMAND;
        const child = spawn(executable!, [...prefix, ...args], {
            cwd: environment.HOME,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.once("error", fail);
        child.once("exit", (code) => done({ code, output }));
    });
}
