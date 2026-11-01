import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const BOT = "k3x9q2w7e5r1t8y4u6i0o3pa";
const OTHER_BOT = "m2n4b6v8c0x1z3l5k7j9h2gf";
const RUNNER_TOKEN = "b".repeat(43);
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Load an installation whose machine `happy.toml` holds `source`. */
async function load(source: string): Promise<ConfigModule> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-execution-config-"));
    roots.push(root);
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "happy.toml"), source);
    return await ConfigModule.load(join(root, ".happy"));
}

describe("execution user configuration", () => {
    it("runs work as the daemon itself unless a user is configured", async () => {
        expect((await load("")).execution).toBeUndefined();
    });

    it("reads the workload user, per-bot users, and the runner executable", async () => {
        const config = await load(
            `[execution]\nuser = "happy-work"\nexecutable = "/usr/local/bin/happy-agent"\n` +
                `[execution.bots.${BOT}]\nuser = "happy-guest"\n` +
                `[execution.bots.${OTHER_BOT}]\nuser = "_ops"\n`,
        );

        expect(config.execution).toEqual({
            user: "happy-work",
            executable: "/usr/local/bin/happy-agent",
            bots: { [BOT]: "happy-guest", [OTHER_BOT]: "_ops" },
        });
    });

    it("starts runners from the daemon's own executable unless one is named", async () => {
        const config = await load(`[execution]\nuser = "happy-work"\n`);

        expect(config.execution).toEqual({
            user: "happy-work",
            executable: process.execPath,
            bots: {},
        });
    });

    it("accepts only plain Linux user names, and never root", async () => {
        for (const user of [
            "Happy",
            "-n",
            "1000",
            "happy work",
            "a".repeat(33),
            "happy:work",
            "",
        ]) {
            await expect(load(`[execution]\nuser = ${JSON.stringify(user)}\n`)).rejects.toThrow(
                "execution.user must be a Linux user name",
            );
        }
        await expect(load(`[execution]\nuser = "root"\n`)).rejects.toThrow(
            "execution.user must not be root",
        );
        await expect(
            load(`[execution]\nuser = "happy-work"\n[execution.bots.${BOT}]\nuser = "root"\n`),
        ).rejects.toThrow(`execution.bots.${BOT}.user must not be root`);
        await expect(load(`[execution]\nuser = 1000\n`)).rejects.toThrow(
            "execution.user must be a Linux user name",
        );
    });

    it("explains every other malformed entry in plain words", async () => {
        await expect(
            load(`[execution]\nexecutable = "/usr/local/bin/happy-agent"\n`),
        ).rejects.toThrow("execution.user must name the Linux user agent work runs as.");
        await expect(load(`[execution]\nuser = "happy-work"\ngroup = "x"\n`)).rejects.toThrow(
            "execution.group is not an execution setting.",
        );
        await expect(
            load(`[execution]\nuser = "happy-work"\nexecutable = "happy-agent"\n`),
        ).rejects.toThrow("execution.executable must be the absolute path");
        await expect(
            load(
                `[execution]\nuser = "happy-work"\n[execution.bots.Chief]\nuser = "happy-guest"\n`,
            ),
        ).rejects.toThrow("execution.bots.Chief must be a bot ID, as list_bots shows it.");
        await expect(
            load(`[execution]\nuser = "happy-work"\n[execution.bots.${BOT}]\nname = "x"\n`),
        ).rejects.toThrow(`execution.bots.${BOT}.name is not a bot execution setting.`);
        await expect(
            load(`[execution]\nuser = "happy-work"\n[execution.bots.${BOT}]\n`),
        ).rejects.toThrow(`execution.bots.${BOT}.user must name a Linux user.`);
        await expect(load(`execution = "happy-work"\n`)).rejects.toThrow(
            "execution must be a TOML table.",
        );
    });

    it("refuses a workload user beside runners, since nothing runs on this machine then", async () => {
        await expect(
            load(
                `[execution]\nuser = "happy-work"\n` +
                    `[runners.build-box]\nname = "Build box"\ntoken = "${RUNNER_TOKEN}"\n`,
            ),
        ).rejects.toThrow("execution applies only to work on this machine");
    });

    it("keeps the workload user when this machine stays the default beside runners", async () => {
        const config = await load(
            `[execution]\nuser = "happy-work"\n` +
                `[runners]\ndefault = "local"\n` +
                `[runners.build-box]\nname = "Build box"\ntoken = "${RUNNER_TOKEN}"\n`,
        );
        expect(config.execution?.user).toBe("happy-work");
        expect(config.runners.defaultId).toBeUndefined();
    });

    it("never lets a project's happy.toml choose the user work runs as", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-execution-project-"));
        roots.push(root);
        await writeFile(
            join(root, "happy.toml"),
            `[execution]\nuser = "happy-work"\n[execution.bots.${BOT}]\nuser = "happy-guest"\n`,
        );
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const config = await ConfigModule.load(join(root, ".happy"));
            expect(config.configuration.sources.local.exists).toBe(true);
            expect(config.execution).toBeUndefined();
        } finally {
            process.chdir(previousCwd);
        }
    });
});
