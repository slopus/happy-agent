#!/usr/bin/env node
// npm's only JavaScript is this launcher. Every runtime role lives in the native executable.
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

const target = `${process.platform}-${process.arch}`;
const filename = process.platform === "win32" ? "happy-agent.exe" : "happy-agent";
let binary = join(
    __dirname,
    "..",
    "dist",
    "bin",
    `happy-agent-${target}${process.platform === "win32" ? ".exe" : ""}`,
);
if (!existsSync(binary)) {
    try {
        binary = require.resolve(`@slopus/happy-agent-${target}/bin/${filename}`);
    } catch {
        console.error(
            `Happy Agent's native executable for ${target} is missing. Reinstall with optional dependencies enabled, or run pnpm --filter @slopus/happy-agent build:native in this checkout.`,
        );
        process.exit(1);
    }
}
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
    console.error(`Happy Agent could not start: ${error.message}`);
    process.exitCode = 1;
});
child.on("exit", (code, signal) => {
    if (signal) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
    } else process.exitCode = code ?? 1;
});
