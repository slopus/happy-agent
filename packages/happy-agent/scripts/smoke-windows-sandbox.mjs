import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, watch } from "node:fs";
import {
    appendFile,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve, win32 } from "node:path";

// Smoke-tests an installed, packaged Windows Agent the way Desktop drives it: the sandbox JSON
// CLI, one sandboxed command through a real daemon, the unattended no-provision guard, and an
// idle daemon that must not grow LSASS (slopus/happy#1950). Only inference is scripted.
//
//   node smoke-windows-sandbox.mjs <unprovisioned|setup|command|idle> <happy-agent.exe> <results>
//
// Run the phases in that order on a disposable, already elevated Windows runner. The first
// phase needs the per-user sandbox to be unprovisioned; the others reuse the setup it skipped.

const [phase, binaryArgument, resultsArgument] = process.argv.slice(2);
if (process.platform !== "win32") throw new Error("The Windows sandbox smoke requires Windows.");
if (!["unprovisioned", "setup", "command", "idle"].includes(phase) || !binaryArgument) {
    throw new Error(
        "Usage: node smoke-windows-sandbox.mjs <unprovisioned|setup|command|idle> <binary> <results>",
    );
}
const binary = resolve(binaryArgument);
const results = resolve(resultsArgument ?? "smoke-results");
await mkdir(results, { recursive: true });
const scratch = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `happy-smoke-${phase}-`));
const report = { phase, binary, startedAt: new Date().toISOString() };

function numberSetting(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
    return value;
}

/** The guard Desktop keeps on its managed daemon; a prepared sandbox must still work under it. */
function guardedEnvironment() {
    const env = { ...process.env, HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "1" };
    delete env.HAPPY_WINDOWS_SANDBOX_HOME;
    return env;
}

function unguardedEnvironment() {
    const env = { ...process.env };
    delete env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION;
    delete env.HAPPY_WINDOWS_SANDBOX_HOME;
    return env;
}

/** Runs one `sandbox ... --json` command and checks the one-line, exit-0 contract. */
function sandboxJson(args, env) {
    const started = Date.now();
    const result = spawnSync(binary, ["sandbox", ...args], {
        encoding: "utf8",
        env,
        timeout: 300_000,
        windowsHide: true,
    });
    const record = {
        args,
        elapsedMs: Date.now() - started,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
    };
    report.cli = [...(report.cli ?? []), record];
    assert.equal(
        result.error,
        undefined,
        `sandbox ${args.join(" ")} did not finish: ${record.error}`,
    );
    assert.equal(
        result.status,
        0,
        `sandbox ${args.join(" ")} exited ${result.status}: ${result.stderr}`,
    );
    const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 1, `sandbox ${args.join(" ")} must print exactly one JSON line.`);
    record.json = JSON.parse(lines[0]);
    return record.json;
}

function assertStatusShape(value) {
    assert.ok(value !== null && typeof value === "object", "Status must be a JSON object.");
    for (const key of Object.keys(value)) {
        assert.ok(
            ["status", "setupVersion", "previousAttempt"].includes(key),
            `Unexpected status field ${key}.`,
        );
    }
    assert.ok(["ready", "required"].includes(value.status), `Unexpected status ${value.status}.`);
    assert.ok(
        Number.isInteger(value.setupVersion) && value.setupVersion >= 0,
        "setupVersion must be a whole number.",
    );
    if (value.previousAttempt !== undefined) {
        assert.ok(
            ["cancelled", "failed"].includes(value.previousAttempt),
            `Unexpected previousAttempt ${value.previousAttempt}.`,
        );
    }
}

function assertSetupShape(value) {
    assert.ok(value !== null && typeof value === "object", "Setup must be a JSON object.");
    for (const key of Object.keys(value)) {
        assert.ok(["status", "setupVersion"].includes(key), `Unexpected setup field ${key}.`);
    }
    assert.ok(
        ["ready", "cancelled", "failed"].includes(value.status),
        `Unexpected setup status ${value.status}.`,
    );
    assert.ok(
        Number.isInteger(value.setupVersion) && value.setupVersion >= 0,
        "setupVersion must be a whole number.",
    );
}

function powershell(command) {
    // A PowerShell 7 parent can inject incompatible modules into Windows PowerShell.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    const result = spawnSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", env, timeout: 120_000, windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function sandboxAccountCount() {
    return Number(powershell("@(Get-LocalUser | Where-Object Name -like 'HappySandbox*').Count"));
}

function temporaryDirectories() {
    // The supervisor creates each command's scratch folder in the Windows temporary directory.
    return [
        ...new Set(
            [process.env.TEMP, process.env.TMP, tmpdir()]
                .filter(Boolean)
                .map((path) => resolve(path)),
        ),
    ];
}

async function leftoverSandboxFolders() {
    let count = 0;
    for (const directory of temporaryDirectories()) {
        const names = await readdir(directory).catch(() => []);
        count += names.filter((name) => name.startsWith("happy-sandbox-")).length;
    }
    return count;
}

/** Counts sandboxed launches by the per-command scratch folders the supervisor creates. */
function watchSandboxLaunches() {
    const seen = new Set();
    const watchers = temporaryDirectories().map((directory) =>
        watch(directory, (_event, name) => {
            if (typeof name === "string" && name.startsWith("happy-sandbox-"))
                seen.add(`${directory}\\${name}`);
        }),
    );
    return { seen, close: () => watchers.forEach((watcher) => watcher.close()) };
}

async function sample(daemonPid) {
    const daemon =
        daemonPid === undefined
            ? "$null"
            : `(Get-Process -Id ${daemonPid} -ErrorAction SilentlyContinue).HandleCount`;
    const measured = JSON.parse(
        powershell(
            "$l = Get-Process -Name lsass; " +
                "$helpers = @(Get-Process -Name 'happy-agent-supervisor','happy-sandbox-runner','happy-sandbox-setup' -ErrorAction SilentlyContinue).Count; " +
                `@{ lsassHandles = $l.HandleCount; lsassPrivateBytes = $l.PrivateMemorySize64; logonSessions = @(Get-CimInstance Win32_LogonSession).Count; daemonHandles = ${daemon}; sandboxProcesses = $helpers } | ConvertTo-Json -Compress`,
        ),
    );
    return {
        at: new Date().toISOString(),
        ...measured,
        sandboxTempFolders: await leftoverSandboxFolders(),
    };
}

function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Scripted inference: one exec_command, polled through write_stdin until it exits. */
function createInference(token) {
    const state = { cmd: undefined, step: 0, polls: 0, messages: [] };
    const server = createServer((request, response) => {
        void (async () => {
            if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
                response.writeHead(401);
                response.end();
                return;
            }
            const chunks = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const sessionId = body?.options?.sessionId;
            if (typeof sessionId === "string" && sessionId.endsWith(":title")) {
                return send(response, {
                    content: [{ type: "text", text: "<title>Windows smoke</title>" }],
                    stopReason: "stop",
                });
            }
            if (state.step === 0) {
                state.step = 1;
                return send(response, {
                    content: [
                        {
                            type: "tool_call",
                            callId: "windows-smoke-command",
                            name: "exec_command",
                            arguments: { cmd: state.cmd, yield_time_ms: 30_000 },
                        },
                    ],
                });
            }
            // Only the conversation is searched: tool descriptions and instructions are not output.
            const messages = JSON.stringify(body?.context?.messages ?? []);
            state.messages.push(body?.context?.messages ?? []);
            const running = /Process running with session ID (\d+)/u.exec(messages);
            if (
                !messages.includes("Process exited with code") &&
                running !== null &&
                state.polls < 10
            ) {
                state.polls += 1;
                return send(response, {
                    content: [
                        {
                            type: "tool_call",
                            callId: `windows-smoke-poll-${state.polls}`,
                            name: "write_stdin",
                            arguments: {
                                session_id: Number(running[1]),
                                chars: "",
                                yield_time_ms: 30_000,
                            },
                        },
                    ],
                });
            }
            state.step = 2;
            send(response, {
                content: [{ type: "text", text: "The Windows smoke command finished." }],
                stopReason: "stop",
            });
        })().catch((error) => {
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            response.end(error instanceof Error ? error.message : String(error));
        });
    });
    return { server, state };
}

function send(response, body) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

async function listen(server) {
    await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    return server.address().port;
}

/** Starts an isolated foreground daemon with its own Happy home and scripted inference. */
async function startDaemon(name, env) {
    const root = join(scratch, name);
    const happyHome = join(root, ".happy");
    const agentDirectory = join(happyHome, "agent");
    await mkdir(root, { recursive: true });
    const token = randomBytes(24).toString("hex");
    const inference = createInference(token);
    const port = await listen(inference.server);
    const log = createWriteStream(join(results, `${phase}-${name}-daemon.log`));
    const child = spawn(binary, ["run"], {
        cwd: root,
        env: {
            ...env,
            HAPPY_GYM_INFERENCE_URL: `http://127.0.0.1:${port}/inference`,
            HAPPY_GYM_TOKEN: token,
            HAPPY_HOME_DIR: happyHome,
            HAPPY_OBSERVATION_LOGS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const identity = createHash("sha256")
        .update(win32.resolve(agentDirectory).toLowerCase())
        .digest("hex");
    const daemon = {
        child,
        happyHome,
        inference,
        root,
        socketPath: `\\\\.\\pipe\\happy-agent-${identity}`,
        token: undefined,
        async stop() {
            await api(daemon, "POST", "/v0/shutdown").catch(() => undefined);
            await Promise.race([
                new Promise((resolveExit) => child.once("exit", resolveExit)),
                sleep(15_000),
            ]);
            if (child.exitCode === null) child.kill();
            inference.server.closeAllConnections?.();
            await new Promise((resolveClose) => inference.server.close(resolveClose));
            log.end();
            await copyFile(
                join(happyHome, "agent", "observation", "agent.log"),
                join(results, `${phase}-${name}-agent.log`),
            ).catch(() => undefined);
            await writeFile(
                join(results, `${phase}-${name}-inference.json`),
                JSON.stringify(inference.state.messages, null, 2),
            );
        },
    };
    try {
        daemon.token = (
            await waitFor(() => readFile(join(agentDirectory, "token"), "utf8"), child, 60_000)
        ).trim();
        await waitFor(
            async () => ((await api(daemon, "GET", "/v0/health")).ready ? true : undefined),
            child,
            120_000,
        );
    } catch (error) {
        await daemon.stop();
        throw error;
    }
    return daemon;
}

function api(daemon, method, path, json) {
    return new Promise((resolveRequest, rejectRequest) => {
        const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
        const request = httpRequest(
            {
                headers: {
                    authorization: `Bearer ${daemon.token}`,
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": String(body.byteLength),
                              "content-type": "application/json",
                          }),
                },
                method,
                path,
                socketPath: daemon.socketPath,
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.once("error", rejectRequest);
                response.once("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode ?? 500) >= 400) {
                        rejectRequest(
                            new Error(
                                `${method} ${path} returned HTTP ${response.statusCode}: ${text}`,
                            ),
                        );
                        return;
                    }
                    resolveRequest(text.length === 0 ? {} : JSON.parse(text));
                });
            },
        );
        request.setTimeout(60_000, () =>
            request.destroy(new Error(`${method} ${path} timed out.`)),
        );
        request.once("error", rejectRequest);
        request.end(body);
    });
}

async function waitFor(check, child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null)
            throw new Error(`The daemon exited with code ${child.exitCode}.`);
        try {
            const value = await check();
            if (value !== undefined) return value;
        } catch (error) {
            lastError = error;
        }
        await sleep(250);
    }
    throw lastError ?? new Error("Timed out waiting for the daemon.");
}

async function registerProject(daemon, path) {
    const registered = await api(daemon, "POST", "/v0/projects", { path });
    // First sandboxed Git reads on a fresh runner can take tens of seconds each.
    return await waitFor(
        async () => {
            const { project } = await api(
                daemon,
                "GET",
                `/v0/projects/${encodeURIComponent(registered.project.id)}`,
            );
            report.projectInitialization = project.initialization;
            return project.initialization.status === "ready" ||
                project.initialization.status === "failed"
                ? project
                : undefined;
        },
        daemon.child,
        180_000,
    );
}

/** Sends one message whose scripted reply runs `cmd` in the restricted workspace sandbox. */
async function runSandboxedCommand(daemon, project, cmd, timeoutMs) {
    daemon.inference.state.cmd = cmd;
    const started = Date.now();
    const { agent } = await api(daemon, "POST", "/v0/agents", {
        title: "Windows sandbox smoke",
        workspaceId: project.id,
    });
    await api(daemon, "POST", `/v0/agents/${encodeURIComponent(agent.id)}/send`, {
        mode: {
            effort: "off",
            modelId: "openai/gym",
            permissionMode: "workspace_write",
            providerId: "gym",
            serviceTier: null,
        },
        text: "Run the Windows sandbox smoke command.",
    });
    const finished = await waitFor(
        async () => {
            const { events } = await api(daemon, "GET", "/v0/events?limit=10000");
            return events.find(
                (event) => event.type === "run.finished" && event.payload.agentId === agent.id,
            );
        },
        daemon.child,
        timeoutMs,
    );
    const transcript = JSON.stringify(daemon.inference.state.messages.at(-1) ?? []);
    return { elapsedMs: Date.now() - started, runStatus: finished.payload.run.status, transcript };
}

const failures = [];
function check(condition, message) {
    if (!condition) failures.push(message);
}

try {
    if (phase === "unprovisioned") {
        // 4. A fresh profile under the unattended guard reports `required` and never provisions.
        const env = guardedEnvironment();
        const before = sandboxJson(["status", "--json"], env);
        assertStatusShape(before);
        assert.equal(
            before.status,
            "required",
            "This phase needs a runner whose sandbox was never set up.",
        );
        check(before.setupVersion > 0, "A working native helper reports its setup version, not 0.");
        check(
            before.previousAttempt === undefined,
            `A fresh profile reported previousAttempt ${before.previousAttempt}.`,
        );
        const setup = sandboxJson(["setup", "--json"], env);
        assertSetupShape(setup);
        check(setup.status === "failed", `Guarded setup must report failed, not ${setup.status}.`);

        const daemon = await startDaemon("guarded", env);
        try {
            const workspace = join(daemon.root, "workspace");
            await mkdir(workspace);
            const project = await registerProject(daemon, workspace);
            if (project.initialization.status === "ready") {
                const run = await runSandboxedCommand(
                    daemon,
                    project,
                    "Write-Output ('guarded-' + 'command-ran')",
                    180_000,
                );
                report.command = { elapsedMs: run.elapsedMs, runStatus: run.runStatus };
                check(
                    run.transcript.includes("windows_sandbox_setup_required"),
                    "The sandboxed command did not fail with windows_sandbox_setup_required.",
                );
                check(
                    !run.transcript.includes("guarded-command-ran"),
                    "The command ran even though the sandbox was never set up.",
                );
            } else {
                check(
                    JSON.stringify(project.initialization).includes(
                        "windows_sandbox_setup_required",
                    ),
                    `Project setup failed without the typed setup error: ${JSON.stringify(project.initialization)}`,
                );
            }
        } finally {
            await daemon.stop();
        }

        const after = sandboxJson(["status", "--json"], env);
        assertStatusShape(after);
        check(
            after.status === "required",
            `The guard did not prevent provisioning: status is ${after.status}.`,
        );
        check(
            after.previousAttempt === undefined,
            `The guard recorded a setup attempt: ${after.previousAttempt}.`,
        );
        report.sandboxAccounts = sandboxAccountCount();
        check(
            report.sandboxAccounts === 0,
            `${report.sandboxAccounts} Happy sandbox accounts exist after guarded use.`,
        );
    }

    if (phase === "setup") {
        // 2. Explicit, user-requested setup without the guard.
        const env = unguardedEnvironment();
        const before = sandboxJson(["status", "--json"], env);
        assertStatusShape(before);
        const setup = sandboxJson(["setup", "--json"], env);
        assertSetupShape(setup);
        assert.equal(
            setup.status,
            "ready",
            `Sandbox setup reported ${setup.status}: ${report.cli.at(-1).stderr}`,
        );
        const after = sandboxJson(["status", "--json"], env);
        assertStatusShape(after);
        check(after.status === "ready", `Status after setup is ${after.status}.`);
        check(
            after.previousAttempt === undefined,
            `Ready status still carries previousAttempt ${after.previousAttempt}.`,
        );
        check(
            setup.setupVersion > 0 && after.setupVersion === setup.setupVersion,
            "Setup and status disagree on setupVersion.",
        );
        check(
            before.setupVersion === setup.setupVersion,
            "Status before setup reported another setupVersion.",
        );
        report.sandboxAccounts = sandboxAccountCount();
        await writeFile(join(results, "sandbox-status-before.json"), JSON.stringify(before));
        await writeFile(join(results, "sandbox-setup.json"), JSON.stringify(setup));
        await writeFile(join(results, "sandbox-status-after.json"), JSON.stringify(after));
    }

    if (phase === "command") {
        // 3. A restricted command through the daemon, under the guard Desktop keeps set.
        const nonce = randomBytes(6).toString("hex");
        const outside = join(homedir(), `happy-smoke-outside-${nonce}.txt`);
        const launches = watchSandboxLaunches();
        const daemon = await startDaemon("prepared", guardedEnvironment());
        try {
            const workspace = join(daemon.root, "workspace");
            await mkdir(workspace);
            const project = await registerProject(daemon, workspace);
            assert.equal(
                project.initialization.status,
                "ready",
                `Project setup failed: ${JSON.stringify(project.initialization)}`,
            );
            // Markers are assembled at runtime so the command text itself never matches them.
            const cmd = [
                `Set-Content -LiteralPath 'inside.txt' -Value ('inside-' + '${nonce}')`,
                `try { Set-Content -LiteralPath '${outside}' -Value 'escaped' -ErrorAction Stop; Write-Output ('outside-' + 'write-allowed') } catch { Write-Output ('outside-' + 'write-denied') }`,
                "Write-Output ('sandbox-' + 'user=' + [Environment]::UserName + '=')",
                `Write-Output ('sandbox-' + 'command-ok-' + '${nonce}')`,
            ].join("; ");
            const run = await runSandboxedCommand(daemon, project, cmd, 300_000);
            const user = /sandbox-user=([^=]*)=/u.exec(run.transcript)?.[1];
            report.command = {
                elapsedMs: run.elapsedMs,
                runStatus: run.runStatus,
                sandboxUser: user,
                runnerUser: userInfo().username,
            };
            check(run.runStatus === "completed", `The agent run ended ${run.runStatus}.`);
            check(
                run.transcript.includes(`sandbox-command-ok-${nonce}`),
                "The sandboxed command output never reached the agent.",
            );
            check(
                run.transcript.includes("Process exited with code 0"),
                "The sandboxed command did not exit 0.",
            );
            check(
                (await readFile(join(workspace, "inside.txt"), "utf8").catch(() => "")).includes(
                    `inside-${nonce}`,
                ),
                "The command could not write its workspace.",
            );
            check(
                run.transcript.includes("outside-write-denied") && !existsSync(outside),
                "The command wrote outside its workspace.",
            );
            check(
                user !== undefined && user.toLowerCase() !== userInfo().username.toLowerCase(),
                `The command ran as ${user}, not a sandbox identity.`,
            );
        } finally {
            await daemon.stop();
            launches.close();
        }
        report.sandboxLaunchesObserved = launches.seen.size;
        // Informational: a zero means the supervisor scratch folders live somewhere else.
        if (launches.seen.size === 0)
            console.warn("No sandbox scratch folders appeared in the temporary directory.");
        report.leftoverSandboxFolders = await leftoverSandboxFolders();
    }

    if (phase === "idle") {
        // 5. slopus/happy#1950: an idle daemon with one Git project whose ignored log is
        // rewritten every second must not keep logging sandbox accounts on through LSASS.
        const minutes = numberSetting("HAPPY_SMOKE_IDLE_MINUTES", 10);
        const limits = {
            lsassHandleGrowth: numberSetting("HAPPY_SMOKE_LSASS_GROWTH_LIMIT", 150),
            logonSessionGrowth: numberSetting("HAPPY_SMOKE_LOGON_SESSION_GROWTH_LIMIT", 5),
            sandboxTempFolderGrowth: numberSetting("HAPPY_SMOKE_TEMP_FOLDER_GROWTH_LIMIT", 2),
            sandboxLaunchesPerMinute: numberSetting("HAPPY_SMOKE_LAUNCHES_PER_MINUTE_LIMIT", 30),
        };
        report.limits = limits;
        const daemon = await startDaemon("idle", guardedEnvironment());
        let churn;
        let launches;
        const samples = [];
        try {
            const workspace = join(daemon.root, "repository");
            await mkdir(join(workspace, "logs"), { recursive: true });
            await writeFile(join(workspace, ".gitignore"), "logs/\n");
            await writeFile(join(workspace, "README.md"), "Windows idle smoke\n");
            for (const args of [
                ["init", "-q"],
                ["add", "."],
                [
                    "-c",
                    "user.name=Happy Smoke",
                    "-c",
                    "user.email=smoke@happy.invalid",
                    "commit",
                    "-q",
                    "-m",
                    "Initial",
                ],
            ]) {
                const git = spawnSync("git", args, {
                    cwd: workspace,
                    encoding: "utf8",
                    windowsHide: true,
                });
                assert.equal(git.status, 0, git.stderr);
            }
            const project = await registerProject(daemon, workspace);
            assert.equal(
                project.initialization.status,
                "ready",
                `Project setup failed: ${JSON.stringify(project.initialization)}`,
            );
            churn = setInterval(
                () =>
                    void writeFile(
                        join(workspace, "logs", "app.log"),
                        `${new Date().toISOString()}\n`,
                    ).catch(() => undefined),
                1_000,
            );
            // Let initial indexing and Git setup finish before the baseline.
            await sleep(60_000);
            launches = watchSandboxLaunches();
            samples.push(await sample(daemon.child.pid));
            const deadline = Date.now() + minutes * 60_000;
            while (Date.now() < deadline) {
                await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
                samples.push(await sample(daemon.child.pid));
                console.log(JSON.stringify(samples.at(-1)));
            }
        } finally {
            clearInterval(churn);
            launches?.close();
            await daemon.stop();
        }
        await sleep(30_000);
        const afterStop = await sample();
        const [first, last] = [samples[0], samples.at(-1)];
        report.samples = samples;
        report.afterDaemonStop = afterStop;
        report.idle = {
            minutes,
            lsassHandlesBefore: first.lsassHandles,
            lsassHandlesAfter: last.lsassHandles,
            lsassHandleGrowth: last.lsassHandles - first.lsassHandles,
            logonSessionGrowth: last.logonSessions - first.logonSessions,
            sandboxTempFoldersBefore: first.sandboxTempFolders,
            sandboxTempFoldersAfter: last.sandboxTempFolders,
            sandboxLaunchesObserved: launches?.seen.size ?? 0,
            sandboxLaunchesPerMinute: Number(((launches?.seen.size ?? 0) / minutes).toFixed(2)),
        };
        const idle = report.idle;
        check(
            idle.lsassHandleGrowth <= limits.lsassHandleGrowth,
            `LSASS grew by ${idle.lsassHandleGrowth} handles while idle.`,
        );
        check(
            idle.logonSessionGrowth <= limits.logonSessionGrowth,
            `${idle.logonSessionGrowth} logon sessions accumulated while idle.`,
        );
        check(
            idle.sandboxTempFoldersAfter - idle.sandboxTempFoldersBefore <=
                limits.sandboxTempFolderGrowth,
            `${idle.sandboxTempFoldersAfter - idle.sandboxTempFoldersBefore} happy-sandbox-* folders were left in TEMP.`,
        );
        check(
            idle.sandboxLaunchesPerMinute <= limits.sandboxLaunchesPerMinute,
            `The idle daemon launched ${idle.sandboxLaunchesPerMinute} sandboxed commands a minute.`,
        );
    }
} catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

report.finishedAt = new Date().toISOString();
report.failures = failures;
await writeFile(join(results, `${phase}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
    const summary =
        failures.length === 0
            ? `- ${phase}: passed`
            : `- ${phase}: **failed**\n${failures.map((failure) => `  - ${failure.split("\n")[0]}`).join("\n")}`;
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
}
