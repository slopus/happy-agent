import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(fileURLToPath(import.meta.url));
const vitestEntry = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const testDirectory = join(root, "tests");
const timingSensitiveTests = new Set([
    "active_run_finishes_after_daemon_restart.test.ts",
    "happy_api_chaos_catalog.test.ts",
    "happy_api_chaos_files.test.ts",
    "happy_api_chaos_recovery.test.ts",
    "happy_api_chaos_runs.test.ts",
    "happy_api_chaos_runtime.test.ts",
    "happy_api_chaos_sync.test.ts",
]);
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
    .map((name) => ({ name, path: join("tests", name) }));

process.stdout.write(`Running ${String(tests.length)} gym test files.\n`);
const results = [
    await runTests(
        "ordinary",
        tests.filter((test) => !timingSensitiveTests.has(test.name)).map((test) => test.path),
        3,
    ),
];
for (const test of tests.filter((candidate) => timingSensitiveTests.has(candidate.name))) {
    results.push(...(await runTimingSensitiveTest(test)));
}

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
        `Running ${String(paths.length)} ${label} gym test files with ${String(workers)} workers.\n`,
    );
    if (paths.length === 0) return Promise.resolve({ status: 0 });
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [
                vitestEntry,
                "run",
                `--maxWorkers=${String(workers)}`,
                "--testTimeout=120000",
                ...paths,
                ...process.argv.slice(2),
            ],
            {
                cwd: root,
                env: { ...process.env, ...additionalEnvironment },
                stdio: "inherit",
                windowsHide: true,
            },
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

async function runTimingSensitiveTest(test: {
    readonly name: string;
    readonly path: string;
}): Promise<Awaited<ReturnType<typeof runTests>>[]> {
    const seeds = isolatedChaosSeeds.get(test.name);
    if (seeds === undefined)
        return [await runTests(`timing-sensitive ${test.name}`, [test.path], 1)];
    const results: Awaited<ReturnType<typeof runTests>>[] = [];
    for (const seed of seeds) {
        results.push(
            await runTests(`timing-sensitive ${test.name} seed=${seed}`, [test.path], 1, {
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
