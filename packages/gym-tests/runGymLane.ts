import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lane = process.argv[2];
if (
    lane !== "local" &&
    lane !== "fast" &&
    lane !== "slow" &&
    lane !== "docker" &&
    lane !== "heavy"
) {
    throw new Error("Usage: node runGymLane.ts <local|fast|slow|docker|heavy>");
}

const root = dirname(fileURLToPath(import.meta.url));
const testDirectory = join(root, "tests");
const slowTests = new Set([
    "agent_waits_past_polling_window_for_workflow.test.ts",
    "claude_background_command_outlives_foreground_timeout.test.ts",
    "completed_work_timer_follows_final_assistant_response.test.ts",
    "daemon_shutdown_drains_background_persistence_before_sqlite_close.test.ts",
    "session_settlement_updates_resume_metadata_and_chimes_once.test.ts",
    "official_codex_and_rig_send_expected_main_inference_prompts.test.ts",
]);
const timingSensitiveTests = new Set([
    "account_quota_observations_survive_rollover_and_resume.test.ts",
    "active_run_finishes_after_daemon_restart.test.ts",
    "docker_managed_network_reaches_allowed_http_service.test.ts",
    "docker_session_routes_files_and_commands_to_container.test.ts",
    "docker_shell_respects_permission_mode.test.ts",
    "happy_api_chaos_catalog.test.ts",
    "happy_api_chaos_files.test.ts",
    "happy_api_chaos_recovery.test.ts",
    "happy_api_chaos_runs.test.ts",
    "happy_api_chaos_runtime.test.ts",
    "happy_api_chaos_sync.test.ts",
    "immediate_submit_after_escape_is_retained_once.test.ts",
    "light_terminal_without_background_query_uses_light_tui_surfaces.test.ts",
    "messages_sent_during_inference_stay_pending_until_consumed.test.ts",
    "reload_reconnects_tui_after_daemon_crash.test.ts",
    "secrets_manager_registers_attaches_and_removes_without_exposing_values.test.ts",
    "slow_startup_quota_does_not_block_composer.test.ts",
    "stale_production_daemon_requires_restart_confirmation.test.ts",
    "steering_submit_escape_race_continues_exactly_once.test.ts",
    "workflow_continues_after_daemon_restart.test.ts",
]);
const isolatedProcessTests = new Set([
    "account_quota_observations_survive_rollover_and_resume.test.ts",
]);
const heavyTests = new Set(["very_large_session_stays_usable_from_fresh_start_and_resume.test.ts"]);
const isolatedChaosSeeds = new Map<string, readonly string[]>([
    ["happy_api_chaos_catalog.test.ts", namedSeeds("C", 24)],
    ["happy_api_chaos_files.test.ts", namedSeeds("F", 16)],
    ["happy_api_chaos_recovery.test.ts", namedSeeds("X", 20)],
    ["happy_api_chaos_runs.test.ts", namedSeeds("R", 20)],
    ["happy_api_chaos_runtime.test.ts", namedSeeds("T", 12)],
    ["happy_api_chaos_sync.test.ts", namedSeeds("S", 28)],
]);

const tests = readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => !name.endsWith(".live.test.ts"))
    .filter((name) => {
        if (lane === "heavy") return heavyTests.has(name);
        if (heavyTests.has(name)) return false;
        const source = readFileSync(join(testDirectory, name), "utf8");
        const usesDocker = /\bmode\s*:\s*["']docker["']/u.test(source);
        if (lane === "docker") return usesDocker;
        if (lane === "local") return !usesDocker;
        return !usesDocker && (lane === "slow") === slowTests.has(name);
    })
    .map((name) => ({ name, path: join("tests", name) }));

process.stdout.write(`Running ${String(tests.length)} ${lane} Gym test files.\n`);
const environment = {
    ...process.env,
    HAPPY_TERMINAL_GYM_RUN_ID: process.env.HAPPY_TERMINAL_GYM_RUN_ID ?? randomUUID(),
    ...(lane === "fast" ? { HAPPY_TERMINAL_GYM_TIME_SCALE: "0.5" } : {}),
};
let results: Awaited<ReturnType<typeof runTests>>[];
if (lane === "docker") {
    results = [
        await runTests(
            "clean-runner Docker",
            tests.filter((test) => isolatedProcessTests.has(test.name)).map((test) => test.path),
            1,
        ),
    ];
    results.push(
        ...(await Promise.all([
            runTests(
                "ordinary Docker",
                tests
                    .filter(
                        (test) => !slowTests.has(test.name) && !timingSensitiveTests.has(test.name),
                    )
                    .map((test) => test.path),
                3,
            ),
            runTests(
                "long-clock Docker",
                tests.filter((test) => slowTests.has(test.name)).map((test) => test.path),
                3,
            ),
        ])),
    );
    for (const test of tests.filter(
        (candidate) =>
            timingSensitiveTests.has(candidate.name) && !isolatedProcessTests.has(candidate.name),
    )) {
        results.push(...(await runTimingSensitiveTest("timing-sensitive Docker", test)));
    }
} else {
    results = [
        await runTests(
            lane,
            tests.filter((test) => !timingSensitiveTests.has(test.name)).map((test) => test.path),
            lane === "heavy" ? 1 : 3,
        ),
    ];
    const timingSensitive = tests
        .filter((test) => timingSensitiveTests.has(test.name))
        .map((test) => test);
    for (const test of timingSensitive) {
        results.push(...(await runTimingSensitiveTest(`${lane} timing-sensitive`, test)));
    }
}

cleanupDockerRunners(environment.HAPPY_TERMINAL_GYM_RUN_ID);

for (const result of results) {
    if (result.error !== undefined) throw result.error;
}
process.exit(results.every((result) => result.status === 0) ? 0 : 1);

function runTests(
    label: string,
    paths: readonly string[],
    workers: number,
    additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ error?: Error; status: number | null }> {
    process.stdout.write(
        `Running ${String(paths.length)} ${label} Gym test files with ${String(workers)} workers.\n`,
    );
    if (paths.length === 0) return Promise.resolve({ status: 0 });
    return new Promise((resolve) => {
        const child = spawn(
            "pnpm",
            [
                "exec",
                "vitest",
                "run",
                `--maxWorkers=${String(workers)}`,
                `--testTimeout=${lane === "fast" ? "120000" : lane === "heavy" ? "360000" : "210000"}`,
                ...paths,
                ...process.argv.slice(3),
            ],
            { cwd: root, env: { ...environment, ...additionalEnvironment }, stdio: "inherit" },
        );
        let error: Error | undefined;
        child.once("error", (cause) => {
            error = cause;
        });
        child.once("close", (status) => {
            resolve({ ...(error === undefined ? {} : { error }), status });
        });
    });
}

async function runTimingSensitiveTest(
    label: string,
    test: { readonly name: string; readonly path: string },
): Promise<Awaited<ReturnType<typeof runTests>>[]> {
    const seeds = isolatedChaosSeeds.get(test.name);
    if (seeds === undefined) return [await runTests(`${label} ${test.name}`, [test.path], 1)];
    const results: Awaited<ReturnType<typeof runTests>>[] = [];
    for (const seed of seeds) {
        results.push(
            await runTests(`${label} ${test.name} seed=${seed}`, [test.path], 1, {
                API_CHAOS_SEED: seed,
            }),
        );
    }
    return results;
}

function namedSeeds(prefix: string, count: number): readonly string[] {
    return Array.from(
        { length: count },
        (_, index) => `${prefix}${String(index).padStart(3, "0")}`,
    );
}

function cleanupDockerRunners(runId: string): void {
    const listed = spawnSync(
        "docker",
        ["ps", "--all", "--quiet", "--filter", `label=happy-terminal.gym.run=${runId}`],
        { encoding: "utf8" },
    );
    const containerIds = listed.stdout?.trim().split(/\s+/u).filter(Boolean) ?? [];
    if (containerIds.length > 0) {
        spawnSync("docker", ["rm", "--force", ...containerIds], { stdio: "ignore" });
    }
    const safeRunId = runId.replaceAll(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 48);
    const prefix = `happy-terminal-gym-pool-${safeRunId}-`;
    for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(prefix)) continue;
        rmSync(join(tmpdir(), name), { force: true, recursive: true });
    }
}
