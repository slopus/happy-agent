import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const MINIMUM_API_SCENARIOS = 596;
const REQUIRED_CHAOS_SEEDS = 120;

interface ListedTest {
    readonly name: string;
    readonly file: string;
}

interface AssertionResult {
    readonly fullName?: string;
    readonly title?: string;
    readonly status?: string;
    readonly failureMessages?: readonly string[];
    readonly retry?: number;
    readonly retries?: number;
}

interface VitestReport {
    readonly success?: boolean;
    readonly numFailedTestSuites?: number;
    readonly numTotalTests?: number;
    readonly numPassedTests?: number;
    readonly numFailedTests?: number;
    readonly numPendingTests?: number;
    readonly numTodoTests?: number;
    readonly numUnhandledErrors?: number;
    readonly unhandledErrors?: readonly unknown[];
    readonly retries?: number;
    readonly numRetries?: number;
    readonly testResults?: readonly {
        readonly assertionResults?: readonly AssertionResult[];
    }[];
}

interface CommandResult {
    readonly exitCode: number;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
}

const repositoryRoot = findRepositoryRoot(process.cwd());
const packageRoot = resolve(repositoryRoot, "packages/gym-tests");
const reportDirectory = resolve(repositoryRoot, ".local/gym-api-suite");
const reportPath = join(reportDirectory, `vitest-${String(process.pid)}.json`);
const apiTestPaths = readdirSync(join(packageRoot, "tests"))
    .filter((name) => /^happy_api_.+\.test\.ts$/u.test(name))
    .sort()
    .map((name) => join("tests", name));
const chaosSuites = [
    { count: 24, file: "happy_api_chaos_catalog.test.ts", prefix: "C" },
    { count: 16, file: "happy_api_chaos_files.test.ts", prefix: "F" },
    { count: 20, file: "happy_api_chaos_recovery.test.ts", prefix: "X" },
    { count: 20, file: "happy_api_chaos_runs.test.ts", prefix: "R" },
    { count: 12, file: "happy_api_chaos_runtime.test.ts", prefix: "T" },
    { count: 28, file: "happy_api_chaos_sync.test.ts", prefix: "S" },
] as const;

await mkdir(reportDirectory, { recursive: true });

const listResult = await runCommand(
    "pnpm",
    ["exec", "vitest", "list", ...apiTestPaths, "--json"],
    packageRoot,
);
if (listResult.exitCode !== 0) {
    throw new Error(
        `Vitest collector failed with exit ${String(listResult.exitCode)}:\n` +
            `${listResult.stderr || listResult.stdout}`,
    );
}

const listed = parseJson<ListedTest[]>(listResult.stdout);
const chaosFilter = process.env.API_CHAOS_SEED?.trim() || undefined;
const chaosPaths = new Set(chaosSuites.map((suite) => join("tests", suite.file)));
const runSpecs =
    chaosFilter === undefined
        ? [
              {
                  label: "ordinary API scenarios",
                  paths: apiTestPaths.filter((path) => !chaosPaths.has(path)),
                  environment: { API_CHAOS_SEED: undefined },
              },
              ...chaosSuites.flatMap((suite) =>
                  namedSeeds(suite.prefix, suite.count).map((seed) => ({
                      label: `${suite.file} seed=${seed}`,
                      paths: [join("tests", suite.file)],
                      environment: { API_CHAOS_SEED: seed },
                  })),
              ),
          ]
        : [
              {
                  label: `focused API scenarios seed=${chaosFilter}`,
                  paths: apiTestPaths,
                  environment: { API_CHAOS_SEED: chaosFilter },
              },
          ];
const reports: VitestReport[] = [];
const runResults: CommandResult[] = [];
for (const [index, spec] of runSpecs.entries()) {
    const partitionPath = join(
        reportDirectory,
        `vitest-${String(process.pid)}-${String(index).padStart(3, "0")}.json`,
    );
    console.error(
        `API gym partition ${String(index + 1)}/${String(runSpecs.length)}: ${spec.label}`,
    );
    const result = await runCommand(
        "pnpm",
        [
            "exec",
            "vitest",
            "run",
            "--maxWorkers=1",
            "--retry=0",
            "--reporter=default",
            "--reporter=json",
            "--reporter=hanging-process",
            `--outputFile.json=${partitionPath}`,
            ...spec.paths,
        ],
        packageRoot,
        spec.environment,
    );
    runResults.push(result);
    try {
        reports.push(JSON.parse(await readFile(partitionPath, "utf8")) as VitestReport);
    } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Vitest did not produce its JSON report at ${partitionPath}: ${reason}`);
    }
}
const report = aggregateReports(reports);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const runResult = aggregateCommandResults(runResults);

const assertions = report.testResults?.flatMap((result) => result.assertionResults ?? []) ?? [];
const chaosAssertions = assertions.filter((assertion) =>
    /\bchaos\s+seed=([A-Za-z0-9_-]+)/i.test(assertion.fullName ?? assertion.title ?? ""),
);
const chaosSeedNames = new Set(
    chaosAssertions.flatMap((assertion) => {
        const name = assertion.fullName ?? assertion.title ?? "";
        const match = /\bchaos\s+seed=([A-Za-z0-9_-]+)/i.exec(name);
        return match?.[1] === undefined ? [] : [match[1]];
    }),
);
const failedAssertions = assertions.filter((assertion) => assertion.status === "failed");
const pendingAssertions = assertions.filter(
    (assertion) =>
        assertion.status === "pending" ||
        assertion.status === "skipped" ||
        assertion.status === "disabled",
);
const todoAssertions = assertions.filter((assertion) => assertion.status === "todo");
const retryCount =
    (report.retries ?? 0) +
    (report.numRetries ?? 0) +
    assertions.reduce(
        (total, assertion) => total + (assertion.retry ?? 0) + (assertion.retries ?? 0),
        0,
    );
const unhandledCount = (report.numUnhandledErrors ?? 0) + (report.unhandledErrors?.length ?? 0);
const passedAssertions = assertions.filter((assertion) => assertion.status === "passed");

const failures: string[] = [];
if (listed.length < MINIMUM_API_SCENARIOS && chaosFilter === undefined) {
    failures.push(
        `Vitest collected ${String(listed.length)} API scenarios; ` +
            `at least ${String(MINIMUM_API_SCENARIOS)} are required.`,
    );
}
if (chaosFilter === undefined && chaosSeedNames.size !== REQUIRED_CHAOS_SEEDS) {
    failures.push(
        `The full run collected ${String(chaosSeedNames.size)} named chaos seeds; ` +
            `exactly ${String(REQUIRED_CHAOS_SEEDS)} are required.`,
    );
}
if (assertions.length !== listed.length || report.numTotalTests !== listed.length) {
    failures.push(
        `Vitest collected ${String(listed.length)} scenarios but reported ` +
            `${String(report.numTotalTests ?? "unknown")} total tests and ` +
            `${String(assertions.length)} assertion results.`,
    );
}
if (passedAssertions.length !== listed.length || report.numPassedTests !== listed.length) {
    failures.push(
        `Only ${String(passedAssertions.length)} of ${String(listed.length)} collected scenarios ` +
            `passed; Vitest reported ${String(report.numPassedTests ?? "unknown")} passes.`,
    );
}
if (failedAssertions.length > 0) {
    failures.push(`${String(failedAssertions.length)} API scenarios failed.`);
}
if (report.success !== true || (report.numFailedTestSuites ?? 0) > 0) {
    failures.push(
        `Vitest reported success=${String(report.success ?? "unknown")} and ` +
            `${String(report.numFailedTestSuites ?? "unknown")} failed test suites.`,
    );
}
if (pendingAssertions.length > 0 || (report.numPendingTests ?? 0) > 0) {
    failures.push(
        `${String(Math.max(pendingAssertions.length, report.numPendingTests ?? 0))} API scenarios skipped/pending.`,
    );
}
if (todoAssertions.length > 0 || (report.numTodoTests ?? 0) > 0) {
    failures.push(
        `${String(Math.max(todoAssertions.length, report.numTodoTests ?? 0))} API scenarios are TODO.`,
    );
}
if (retryCount > 0) failures.push(`${String(retryCount)} retries were reported.`);
if (unhandledCount > 0) failures.push(`${String(unhandledCount)} unhandled errors were reported.`);
if (runResult.exitCode !== 0 && failures.length === 0) {
    failures.push(
        `Vitest exited with code ${String(runResult.exitCode)}` +
            (runResult.signal === null ? "." : ` after ${runResult.signal}.`),
    );
}

const summary = [
    `API gym: collected=${String(listed.length)}`,
    `assertions=${String(assertions.length)}`,
    `passed=${String(passedAssertions.length)}`,
    `chaosSeeds=${String(chaosSeedNames.size)}`,
    `report=${reportPath}`,
];
console.error(summary.join(" "));

if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    if (runResult.exitCode !== 0) {
        const diagnostics = [runResult.stderr, runResult.stdout]
            .map((output) => output.trim())
            .filter((output) => output.length > 0)
            .join("\n");
        if (diagnostics.length > 0) console.error(`VITEST OUTPUT:\n${diagnostics}`);
    }
    for (const assertion of failedAssertions) {
        console.error(
            `FAILED ${assertion.fullName ?? assertion.title ?? "unnamed"}\n` +
                `${(assertion.failureMessages ?? []).join("\n")}`,
        );
    }
    process.exitCode = 1;
} else {
    process.exitCode = 0;
}

function namedSeeds(prefix: string, count: number): readonly string[] {
    return Array.from(
        { length: count },
        (_, index) => `${prefix}${String(index).padStart(3, "0")}`,
    );
}

function aggregateReports(reports: readonly VitestReport[]): VitestReport {
    return {
        success: reports.every((report) => report.success === true),
        numFailedTestSuites: sum(reports, (report) => report.numFailedTestSuites),
        numTotalTests: sum(reports, (report) => report.numTotalTests),
        numPassedTests: sum(reports, (report) => report.numPassedTests),
        numFailedTests: sum(reports, (report) => report.numFailedTests),
        numPendingTests: sum(reports, (report) => report.numPendingTests),
        numTodoTests: sum(reports, (report) => report.numTodoTests),
        numUnhandledErrors: sum(reports, (report) => report.numUnhandledErrors),
        retries: sum(reports, (report) => report.retries),
        numRetries: sum(reports, (report) => report.numRetries),
        unhandledErrors: reports.flatMap((report) => report.unhandledErrors ?? []),
        testResults: reports.flatMap((report) => report.testResults ?? []),
    };
}

function sum(
    reports: readonly VitestReport[],
    value: (report: VitestReport) => number | undefined,
): number {
    return reports.reduce((total, report) => total + (value(report) ?? 0), 0);
}

function aggregateCommandResults(results: readonly CommandResult[]): CommandResult {
    const failed = results.filter((result) => result.exitCode !== 0);
    return {
        exitCode: failed.length === 0 ? 0 : 1,
        signal: failed.find((result) => result.signal !== null)?.signal ?? null,
        stdout: failed.map((result) => result.stdout).join("\n"),
        stderr: failed.map((result) => result.stderr).join("\n"),
    };
}

async function runCommand(
    command: string,
    args: readonly string[],
    cwd: string,
    additionalEnvironment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
    const environment = { ...process.env };
    for (const [name, value] of Object.entries(additionalEnvironment)) {
        if (value === undefined) delete environment[name];
        else environment[name] = value;
    }
    return await new Promise<CommandResult>((resolveResult, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Uint8Array[] = [];
        const stderr: Uint8Array[] = [];
        child.stdout.on("data", (chunk: Uint8Array) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Uint8Array) => stderr.push(chunk));
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
            resolveResult({
                exitCode: exitCode ?? 1,
                signal,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
            });
        });
    });
}

function parseJson<Value>(output: string): Value {
    const clean = output.replaceAll(/\u001b\[[0-9;]*m/g, "").trim();
    try {
        return JSON.parse(clean) as Value;
    } catch {
        const candidates = [clean.indexOf("["), clean.indexOf("{")]
            .filter((index) => index >= 0)
            .sort((left, right) => left - right);
        for (const start of candidates) {
            try {
                return JSON.parse(clean.slice(start)) as Value;
            } catch {
                // Try the next possible JSON prefix. The command output is
                // retained in the thrown error below for diagnosis.
            }
        }
    }
    throw new Error(`Unable to parse Vitest JSON output:\n${output}`);
}

function findRepositoryRoot(start: string): string {
    let current = resolve(start);
    for (;;) {
        if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
        const parent = resolve(current, "..");
        if (parent === current) throw new Error("Could not locate the repository root.");
        current = parent;
    }
}
