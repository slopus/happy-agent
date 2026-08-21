import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "DAEMON_CRASH_STACK_AND_DIAGNOSTIC_DUMP_WRITTEN";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon crash diagnostics", () => {
    it("writes a stack-bearing log record and an environment-redacted diagnostic dump", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/crash-daemon-and-check-report.sh"],
            files: {
                "crash-daemon-and-check-report.sh": crashDaemonAndCheckReportScript,
                "crash-daemon-preload.cjs": crashDaemonPreloadScript,
                "verify-daemon-crash-report.mjs": verifyDaemonCrashReportScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Daemon crash report contains JS and native stacks");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const crashDaemonAndCheckReportScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/rig/dist/main.js "$@"
}

export RIG_SERVER_DIRECTORY="/home/rig/.local/state/rig-crash-report"
export RIG_SERVER_SOCKET_PATH="/tmp/rig-crash-report.sock"
export RIG_CRASH_TEST_SECRET="must-not-appear-in-report"
export NODE_OPTIONS="$NODE_OPTIONS --require=/workspace/crash-daemon-preload.cjs"
registry_path="$RIG_SERVER_DIRECTORY/server.json"

wait_for_exit() {
    local target_pid="$1"
    for _ in $(seq 1 200); do
        if ! kill -0 "$target_pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.05
    done
    echo "Daemon process $target_pid did not exit after its uncaught exception." >&2
    return 1
}

rig daemon start
daemon_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).pid))' "$registry_path")"
touch /workspace/trigger-daemon-crash
wait_for_exit "$daemon_pid"
node /workspace/verify-daemon-crash-report.mjs

echo "Daemon crash report contains JS and native stacks"
echo ${COMPLETED_MARKER}
sleep 60
`;

const crashDaemonPreloadScript = String.raw`
if (process.argv[1] !== undefined && process.argv[1].endsWith("/agent.js") && process.argv.includes("run")) {
    const { existsSync } = require("node:fs");
    const timer = setInterval(() => {
        if (!existsSync("/workspace/trigger-daemon-crash")) return;
        clearInterval(timer);
        setImmediate(() => {
            throw new Error("daemon uncaught crash marker");
        });
    }, 20);
}
`;

const verifyDaemonCrashReportScript = String.raw`
import { readFile, readdir, stat } from "node:fs/promises";

const directory = process.env.RIG_SERVER_DIRECTORY;
if (directory === undefined) throw new Error("RIG_SERVER_DIRECTORY is missing.");
const diagnostics = directory + "/diagnostics";
const names = await readdir(diagnostics);
const log = await readFile(directory + "/server.log", "utf8");
const reportName = names.find((name) => /^report\..+\.json$/u.test(name));
if (reportName === undefined) {
    throw new Error(
        "The daemon did not write a diagnostic report. Diagnostics: " +
            names.join(", ") +
            ". Log: " +
            log.slice(-2_000),
    );
}
const reportPath = diagnostics + "/" + reportName;
const report = await readFile(reportPath, "utf8");
if (!report.includes("daemon uncaught crash marker")) {
    throw new Error("The diagnostic report does not contain the crash marker.");
}
if (!report.includes('"javascriptStack"') || !report.includes('"nativeStack"')) {
    throw new Error("The diagnostic report is missing JS or native stack state.");
}
if (report.includes("must-not-appear-in-report")) {
    throw new Error("The diagnostic report persisted an environment secret.");
}
if (((await stat(reportPath)).mode & 0o077) !== 0) {
    throw new Error("The diagnostic report is readable by another user.");
}

const records = log
    .split("\n")
    .flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
const fatal = records.find((record) => record.event === "daemon_fatal_error");
if (fatal === undefined || !fatal.errorStack?.includes("daemon uncaught crash marker")) {
    throw new Error("The daemon log does not contain the uncaught exception stack.");
}
`;
