#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = process.argv.includes("--worker");
const hard = process.argv.includes("--hard");
const happyHome = process.env.HAPPY_HOME_DIR?.trim() || join(homedir(), ".happy");
const binary = join(happyHome, "dist", "version", "0.0.0", "happy-agent");
const logPath = join(happyHome, "agent", "local-reload.log");

if (!existsSync(binary)) throw new Error(`Local Happy Agent is not installed at ${binary}`);

if (!worker) {
    mkdirSync(dirname(logPath), { recursive: true });
    const log = openSync(logPath, "a");
    const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "--worker", ...(hard ? ["--hard"] : [])],
        { detached: true, env: process.env, stdio: ["ignore", log, log] },
    );
    child.unref();
    closeSync(log);
    console.log(`Detached local Happy Agent reload; log: ${logPath}`);
} else {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    console.log(`${new Date().toISOString()} Reloading local Happy Agent${hard ? " (hard)" : ""}.`);
    if (!hard && (await run("reload", 30_000))) process.exit(0);
    console.log(
        `${new Date().toISOString()} ${hard ? "Forcing restart." : "Graceful reload did not finish; forcing restart."}`,
    );
    await run("kill", 10_000);
    if (!(await run("start", 75_000))) process.exitCode = 1;
}

function run(command, timeout) {
    return new Promise((resolve) => {
        execFile(
            binary,
            [command],
            {
                env: { ...process.env, HAPPY_HOME_DIR: happyHome },
                killSignal: "SIGKILL",
                timeout,
            },
            (error, stdout, stderr) => {
                if (stdout) process.stdout.write(stdout);
                if (stderr) process.stderr.write(stderr);
                resolve(error === null);
            },
        );
    });
}
