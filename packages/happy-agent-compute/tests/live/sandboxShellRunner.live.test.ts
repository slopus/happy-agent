import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import { SandboxShellRunner } from "../../sources/host/impl/SandboxShellRunner.js";
import { NativeProcessManager } from "../../sources/processes/index.js";
import { resolvePotentialPath } from "../../sources/sandbox/impl/resolvePotentialPath.js";
import {
    createSupervisorPolicy,
    createSupervisorShellRunnerCommand,
} from "../../sources/supervisor/index.js";

// Runs against a provisioned Windows sandbox. HAPPY_AGENT_COMPUTE_TEST_SUPERVISOR selects a
// development build of the native supervisor; the installed one is used otherwise.
const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1" && process.platform === "win32";

describe.runIf(LIVE)("live Windows sandbox shell runner", () => {
    const ctx = createRootContext().named("happy-agent-compute-shell-runner-live-test");
    const manager = new NativeProcessManager(ctx);
    let root: string;
    let runner: SandboxShellRunner;
    const shell = "C:\\Windows\\System32\\cmd.exe";

    beforeAll(async () => {
        root = await resolvePotentialPath(await mkdtemp(join(tmpdir(), "happy-shell-runner-")));
        const supervisorPath = resolveSupervisorBinary(
            process.env.HAPPY_AGENT_COMPUTE_TEST_SUPERVISOR,
        );
        const command = createSupervisorShellRunnerCommand({
            cwd: root,
            policy: createSupervisorPolicy({
                cwd: root,
                permissions: computePermissions("workspace_write"),
            }),
            supervisorPath,
        });
        runner = new SandboxShellRunner({
            ...command,
            ctx,
            environment: process.env,
            processCwd: dirname(supervisorPath),
        });
    }, 120_000);
    afterAll(async () => {
        await runner?.dispose();
        await rm(root, { force: true, recursive: true });
    });

    const start = (script: string, env: NodeJS.ProcessEnv = {}) =>
        manager.start(ctx, {
            command: script,
            cwd: root,
            transport: () =>
                runner.start({
                    argv: [shell, "/d", "/s", "/c", script],
                    env: { ...process.env, ...env },
                    tty: false,
                }),
        });

    it("runs commands concurrently, each with its own environment and scratch folder", async () => {
        const results = await Promise.all(
            [1, 2, 3, 4].map(async (index) =>
                (
                    await start(
                        `echo %ONLY_MINE%^|%TEMP%& echo ${String(index)}> out${String(index)}.txt`,
                        {
                            ONLY_MINE: `value-${String(index)}`,
                        },
                    )
                ).wait(ctx),
            ),
        );
        const scratch = new Set<string>();
        for (const [offset, result] of results.entries()) {
            expect(result.exitCode, result.stderr).toBe(0);
            const [value, temp] = result.stdout.trim().split("|");
            expect(value).toBe(`value-${String(offset + 1)}`);
            scratch.add(temp!);
            expect(
                (await readFile(join(root, `out${String(offset + 1)}.txt`), "utf8")).trim(),
            ).toBe(String(offset + 1));
        }
        expect(scratch.size).toBe(4);
        // A command's scratch folder is deleted when it ends.
        for (const folder of scratch) expect(existsSync(folder)).toBe(false);
    }, 600_000);

    it("delivers input and stops one command without disturbing another", async () => {
        const reader = await start("findstr x");
        const sleeper = await start("ping -n 60 127.0.0.1 >nul");
        await reader.writeStdin(ctx, "x marks\r\n");
        await reader.endStdin(ctx);
        const read = await reader.wait(ctx);
        expect(read.stdout).toContain("x marks");
        expect(sleeper.status).toBe("running");
        const started = Date.now();
        await sleeper.kill(ctx);
        expect((await sleeper.wait(ctx)).killed).toBe(true);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(runner.activeCount).toBe(0);
    }, 600_000);

    it("keeps the sandbox boundary: writes outside the workspace are refused", async () => {
        const outside = join(dirname(root), `happy-runner-outside-${String(Date.now())}.txt`);
        const result = await (await start(`echo nope> "${outside}"`)).wait(ctx);
        expect(result.exitCode).not.toBe(0);
        expect(existsSync(outside)).toBe(false);
    }, 600_000);
});
