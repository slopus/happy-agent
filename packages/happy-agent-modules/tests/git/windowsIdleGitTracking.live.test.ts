import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/GitModule.js";
import { directGitCommandRunner } from "../../sources/git/runGitCommand.js";
import { runScanGit } from "../../sources/git/runScanGit.js";
import { cleanupRoots, commitFile, createRepository, setOriginMain } from "./helpers.js";

// On Windows every read-only Git scan is a sandboxed process that logs a sandbox account on
// through LSASS. Projects left open while nobody works still see their logs, caches, and build
// output rewritten. If each of those writes launches a scan, LSASS gains handles until the
// machine freezes (slopus/happy#1950). This drives live tracking through that churn for a minute
// against the real sandbox and measures both the launches and LSASS.

const sandboxReady =
    process.platform === "win32" && process.env.HAPPY_WINDOWS_SANDBOX_HOME !== undefined;
const REPOSITORIES = 4;
const CHURN_MS = 60_000;
const WRITE_INTERVAL_MS = 200;
const SETTLE_MS = 15_000;

const modules: GitModule[] = [];
afterEach(async () => {
    for (const module of modules.splice(0)) module.dispose();
    await cleanupRoots();
});

describe.runIf(sandboxReady)("idle Windows Git tracking", () => {
    it(
        "does not launch a sandboxed scan for every write to an ignored file",
        async () => {
            let scans = 0;
            const module = GitModule.withRunner({
                run: (cwd, args, options) => directGitCommandRunner.run(cwd, args, options),
                scan: async (options) => {
                    scans += 1;
                    return await runScanGit(options);
                },
            });
            modules.push(module);
            const entities = [];
            for (let index = 0; index < REPOSITORIES; index += 1) {
                const repository = await createRepository();
                const head = await commitFile(repository, ".gitignore", "*.log\ncache/\n");
                await setOriginMain(repository, head);
                await mkdir(join(repository, "cache"));
                entities.push({ path: repository, projectId: `idle-project-${index}` });
            }
            for (const entity of entities) module.track(entity);
            await waitFor(() => entities.every((entity) => module.trackedSnapshot(entity)));
            await waitForQuiet(() => scans, 5_000);

            const before = sample();
            const scansBefore = scans;
            const started = Date.now();
            let write = 0;
            while (Date.now() - started < CHURN_MS) {
                write += 1;
                await Promise.all(
                    entities.map(async (entity) => {
                        await writeFile(join(entity.path, "server.log"), `request ${write}\n`, {
                            flag: "a",
                        });
                        await writeFile(join(entity.path, "cache", `entry-${write % 20}`), "x");
                    }),
                );
                await new Promise((resolve) => setTimeout(resolve, WRITE_INTERVAL_MS));
            }
            const churnScans = scans - scansBefore;
            const after = sample();
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
            const settled = sample();
            const report = {
                repositories: REPOSITORIES,
                churnSeconds: CHURN_MS / 1000,
                writesPerRepository: write * 2,
                sandboxedScans: churnScans,
                lsassBefore: before.lsass,
                lsassAfter: after.lsass,
                lsassSettled: settled.lsass,
                lsassGrowth: settled.lsass - before.lsass,
                agentHandlesBefore: before.agent,
                agentHandlesSettled: settled.agent,
                agentHandleGrowth: settled.agent - before.agent,
            };
            console.log(`idle-git-tracking ${JSON.stringify(report)}`);

            // One scoped status per repository learns that the log and the cache are ignored.
            expect(churnScans).toBeLessThanOrEqual(REPOSITORIES * 3);
            expect(report.lsassGrowth).toBeLessThan(150);
            expect(report.agentHandleGrowth).toBeLessThan(150);
        },
        CHURN_MS + SETTLE_MS + 120_000,
    );
});

function sample(): { agent: number; lsass: number } {
    const command =
        `$l = Get-Process -Name lsass; $a = Get-Process -Id ${process.pid}; ` +
        `@{ lsass = $l.HandleCount; agent = $a.HandleCount } | ConvertTo-Json -Compress`;
    const result = spawnSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", timeout: 60_000, windowsHide: true },
    );
    if (result.status !== 0) throw new Error(result.stderr || "Could not read handle counts.");
    return JSON.parse(result.stdout) as { agent: number; lsass: number };
}

async function waitFor(predicate: () => unknown): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for Git tracking.");
}

async function waitForQuiet(read: () => number, durationMs: number): Promise<void> {
    const deadline = Date.now() + 120_000;
    let observed = read();
    let stableSince = Date.now();
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (read() !== observed) {
            observed = read();
            stableSince = Date.now();
        } else if (Date.now() - stableSince >= durationMs) {
            return;
        }
    }
    throw new Error("Timed out waiting for initial Git tracking to settle.");
}
