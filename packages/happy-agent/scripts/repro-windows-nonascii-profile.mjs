import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { homedir, userInfo } from "node:os";
import { join, resolve, win32 } from "node:path";

// slopus/happy-agent#90: run as a Windows user whose profile path holds non-ASCII characters and
// prove that the credential folders in that profile are denied to sandboxed commands, and that
// the deny-read ACL state names the real folders.
//
//   node repro-windows-nonascii-profile.mjs <happy-agent.exe> <results> <work>
//
// Run it as that user, already elevated, on a disposable runner. <work> must be outside the
// profile. A batch-logon session cannot start the sandbox runner on the interactive window
// station, so HAPPY_REPRO_PROFILE instead runs as the current user with USERPROFILE pointing at a
// non-ASCII folder, which is where the Agent looks for credential folders. Sandbox state always
// stays in the real profile. HAPPY_REPRO_SKIP_READS=1 records a session that cannot run commands.

const [binaryArgument, resultsArgument, workArgument] = process.argv.slice(2);
if (process.platform !== "win32") throw new Error("This reproduction requires Windows.");
const binary = resolve(binaryArgument);
const results = resolve(resultsArgument);
const work = resolve(workArgument);
await mkdir(results, { recursive: true });
await mkdir(work, { recursive: true });
const report = { startedAt: new Date().toISOString() };
const failures = [];
function check(condition, message) {
    if (!condition) failures.push(message);
}

function describe(text) {
    return {
        text,
        codePoints: [...text]
            .filter((character) => character.codePointAt(0) > 0x7e)
            .map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`),
        utf8: Buffer.from(text, "utf8").toString("hex"),
    };
}

function powershell(command) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    const result = spawnSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
                `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${command}`,
                "utf16le",
            ).toString("base64"),
        ],
        { encoding: "utf8", env, timeout: 120_000, windowsHide: true },
    );
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function literal(path) {
    return `'${path.replaceAll("'", "''")}'`;
}

function sandboxJson(args, env) {
    const result = spawnSync(binary, ["sandbox", ...args], {
        encoding: "utf8",
        env,
        timeout: 300_000,
        windowsHide: true,
    });
    const record = { args, status: result.status, stdout: result.stdout, stderr: result.stderr };
    report.cli = [...(report.cli ?? []), record];
    return record;
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
                    content: [{ type: "text", text: "<title>Non-ASCII profile</title>" }],
                    stopReason: "stop",
                });
            }
            if (state.step === 0) {
                state.step = 1;
                return send(response, {
                    content: [
                        {
                            type: "tool_call",
                            callId: "nonascii-command",
                            name: "exec_command",
                            arguments: { cmd: state.cmd, yield_time_ms: 30_000 },
                        },
                    ],
                });
            }
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
                            callId: `nonascii-poll-${state.polls}`,
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
                content: [{ type: "text", text: "Done." }],
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
                            new Error(`${method} ${path}: HTTP ${response.statusCode} ${text}`),
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

async function startDaemon(root, env) {
    const happyHome = join(root, ".happy");
    const agentDirectory = join(happyHome, "agent");
    await mkdir(root, { recursive: true });
    const token = randomBytes(24).toString("hex");
    const inference = createInference(token);
    await new Promise((resolveListen, rejectListen) => {
        inference.server.once("error", rejectListen);
        inference.server.listen(0, "127.0.0.1", resolveListen);
    });
    const port = inference.server.address().port;
    const log = createWriteStream(join(results, "daemon.log"));
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
        inference,
        socketPath: `\\\\.\\pipe\\happy-agent-${identity}`,
        token: undefined,
        async stop() {
            await api(daemon, "POST", "/v0/shutdown").catch(() => undefined);
            await Promise.race([new Promise((done) => child.once("exit", done)), sleep(15_000)]);
            if (child.exitCode === null) child.kill();
            inference.server.closeAllConnections?.();
            await new Promise((done) => inference.server.close(done));
            log.end();
            await copyFile(
                join(happyHome, "agent", "observation", "agent.log"),
                join(results, "agent.log"),
            ).catch(() => undefined);
            await writeFile(
                join(results, "inference.json"),
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

async function runSandboxedCommand(daemon, workspace, cmd) {
    const registered = await api(daemon, "POST", "/v0/projects", { path: workspace });
    const project = await waitFor(
        async () => {
            const { project } = await api(
                daemon,
                "GET",
                `/v0/projects/${encodeURIComponent(registered.project.id)}`,
            );
            return ["ready", "failed"].includes(project.initialization.status)
                ? project
                : undefined;
        },
        daemon.child,
        180_000,
    );
    report.projectInitialization = project.initialization;
    assert.equal(project.initialization.status, "ready", JSON.stringify(project.initialization));
    daemon.inference.state.cmd = cmd;
    const { agent } = await api(daemon, "POST", "/v0/agents", {
        title: "Non-ASCII profile",
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
        text: "Try to read the credential folders.",
    });
    const finished = await waitFor(
        async () => {
            const { events } = await api(daemon, "GET", "/v0/events?limit=10000");
            return events.find(
                (event) => event.type === "run.finished" && event.payload.agentId === agent.id,
            );
        },
        daemon.child,
        300_000,
    );
    return {
        runStatus: finished.payload.run.status,
        transcript: JSON.stringify(daemon.inference.state.messages.at(-1) ?? []),
    };
}

const profile = process.env.HAPPY_REPRO_PROFILE || homedir();
const realProfile = userInfo().homedir;
const checkReads = process.env.HAPPY_REPRO_SKIP_READS !== "1";
const nonce = randomBytes(6).toString("hex");
const secrets = {
    claude: { path: join(profile, ".claude", "repro-secret.txt"), value: `claude-${nonce}` },
    codex: { path: join(profile, ".codex", "repro-auth.json"), value: `codex-${nonce}` },
};
// The same non-ASCII name outside every denied folder proves the path reaches the command intact.
const visible = {
    path: join(work, win32.basename(profile), "repro-visible.txt"),
    value: `visible-${nonce}`,
};
const stateFile = join(
    realProfile,
    ".happy",
    "windows-sandbox",
    ".sandbox",
    "deny_read_acl_state.json",
);

try {
    report.user = userInfo().username;
    report.profile = describe(profile);
    report.realProfile = describe(realProfile);
    report.userProfileVariable = describe(process.env.USERPROFILE ?? "");
    check(/[^\x00-\x7f]/u.test(profile), `The profile ${profile} has no non-ASCII character.`);
    for (const secret of [...Object.values(secrets), visible]) {
        await mkdir(join(secret.path, ".."), { recursive: true });
        await writeFile(secret.path, secret.value);
    }

    const env = { ...process.env, USERPROFILE: profile };
    delete env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION;
    delete env.HAPPY_WINDOWS_SANDBOX_HOME;
    const setup = sandboxJson(["setup", "--json"], env);
    check(
        setup.status === 0 && setup.stdout.includes('"ready"'),
        `Setup failed: ${setup.stdout} ${setup.stderr}`,
    );

    // A workspace inside the profile is the ordinary layout, and it is the only one in which the
    // policy names the credential folders without denying the whole profile.
    const workspaces = [
        { label: "profile", path: join(profile, "happy-repro-workspace") },
        { label: "outside", path: join(work, "workspace") },
    ];
    report.command = {};
    for (const workspace of workspaces) {
        const daemon = await startDaemon(join(work, `daemon-${workspace.label}`), {
            ...env,
            HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "1",
        });
        try {
            await mkdir(workspace.path, { recursive: true });
            // Markers are assembled at runtime so the command text itself never matches them.
            const cmd = Object.entries({ ...secrets, visible })
                .map(
                    ([name, secret]) =>
                        `try { $v = [IO.File]::ReadAllText(${literal(secret.path)}); Write-Output ('${name}-' + 'read-' + 'allowed:' + $v) } ` +
                        `catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; Write-Output ('${name}-' + 'read-' + 'failed:' + $e.GetType().Name) }`,
                )
                .join("; ");
            const run = await runSandboxedCommand(daemon, workspace.path, cmd);
            const outcome = { runStatus: run.runStatus };
            for (const name of ["visible", ...Object.keys(secrets)]) {
                outcome[name] =
                    /(?<=-read-)(allowed|failed:\w+)/u.exec(
                        run.transcript.slice(run.transcript.indexOf(`${name}-read-`)),
                    )?.[0] ?? "no result";
            }
            check(
                outcome.visible === "allowed" || !checkReads,
                `The control read of ${visible.path} in the ${workspace.label} workspace was ${outcome.visible}: ${run.transcript.slice(-1500)}`,
            );
            for (const [name, secret] of Object.entries(secrets)) {
                check(
                    outcome[name] !== "allowed" && !run.transcript.includes(secret.value),
                    `A sandboxed command in the ${workspace.label} workspace read ${secret.path}.`,
                );
                check(
                    outcome[name] === "failed:UnauthorizedAccessException" || !checkReads,
                    `The ${name} read in the ${workspace.label} workspace was ${outcome[name]}, not access denied.`,
                );
            }
            report.command[workspace.label] = outcome;
        } catch (error) {
            report.command[workspace.label] = { error: String(error) };
            check(false, `The ${workspace.label} workspace command failed: ${error}`);
        } finally {
            await daemon.stop();
            for (const name of ["daemon.log", "agent.log", "inference.json"]) {
                await copyFile(
                    join(results, name),
                    join(results, `${workspace.label}-${name}`),
                ).catch(() => undefined);
            }
        }
    }

    // The persistent deny-read ACL state must name the real credential folders.
    const stateBytes = await readFile(stateFile).catch(() => undefined);
    check(stateBytes !== undefined, `No deny-read ACL state at ${stateFile}.`);
    if (stateBytes !== undefined) {
        await copyFile(stateFile, join(results, "deny_read_acl_state.json"));
        report.stateHex = stateBytes.toString("hex");
        const state = JSON.parse(stateBytes.toString("utf8"));
        const statePaths = Object.values(state.principals ?? {}).flat();
        report.statePaths = statePaths.map((path) => ({
            ...describe(path),
            exists: existsSync(path),
        }));
        for (const folder of [".claude", ".codex"]) {
            const expected = join(profile, folder).toLowerCase();
            check(
                statePaths.some((path) => path.toLowerCase() === expected),
                `The deny-read state does not name ${join(profile, folder)}.`,
            );
        }
        const strays = statePaths.filter(
            (path) =>
                path.toLowerCase().startsWith(win32.dirname(profile).toLowerCase()) &&
                !path.toLowerCase().startsWith(profile.toLowerCase()),
        );
        check(
            strays.length === 0,
            `Deny-read state names paths in another profile: ${strays.join(", ")}`,
        );
    }

    for (const folder of [".claude", ".codex"]) {
        report[`acl${folder}`] = powershell(`icacls ${literal(join(profile, folder))}`);
    }
    report.usersDirectory = (await readdir(win32.dirname(profile))).map(describe);
    const sandboxLogs = join(realProfile, ".happy", "windows-sandbox", ".sandbox");
    for (const name of await readdir(sandboxLogs).catch(() => [])) {
        if (name.endsWith(".log")) await copyFile(join(sandboxLogs, name), join(results, name));
    }
} catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

report.finishedAt = new Date().toISOString();
report.failures = failures;
await writeFile(join(results, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const summary = process.env.HAPPY_REPRO_SUMMARY;
if (summary) {
    await appendFile(
        summary,
        failures.length === 0
            ? "- non-ASCII profile: passed\n"
            : `- non-ASCII profile: **failed**\n${failures.map((failure) => `  - ${failure.split("\n")[0]}`).join("\n")}\n`,
    );
}
process.exit(failures.length > 0 ? 1 : 0);
