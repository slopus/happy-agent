// Exercise the public sandbox commands and their same-executable helper role.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

assert.equal(process.platform, "win32", "This gate needs native Windows.");
assert(process.argv[2], "Select the built Windows executable.");
const binary = resolve(process.argv[2]);
const invoke = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "happy-windows-sandbox-cli-"));
const metadata = JSON.parse(
    await readFile("packages/happy-agent-supervisor/native/windows/source.json", "utf8"),
);
const version = metadata.setupVersion;
const explicit = join(root, "state with spaces 🎉");
const daemonHome = join(root, "unrelated-daemon-home");
const options = {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    env: {
        ...process.env,
        HAPPY_HOME_DIR: daemonHome,
        HOME: join(root, "untrusted-home"),
        USERPROFILE: join(root, "untrusted-profile"),
        HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "1",
        HAPPY_WINDOWS_SANDBOX_HOME: `  ${explicit}  `,
    },
};
async function run(args, env = {}) {
    try {
        const result = await invoke(binary, args, { ...options, env: { ...options.env, ...env } });
        return { ...result, code: 0 };
    } catch (error) {
        assert.equal(
            typeof error.code,
            "number",
            `Failed to execute the selected binary: ${error}`,
        );
        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
}
async function absent(path) {
    await assert.rejects(access(path), { code: "ENOENT" });
}
function unavailable(result, code) {
    assert.equal(result.code, code, result.stderr);
    assert.match(result.stderr, /filesystem, sensitive-read, and network isolation/i);
    assert.doesNotMatch(result.stderr, /migration is not yet complete/i);
}
try {
    await absent(explicit);
    const status = await run(["sandbox", "status"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Happy's Windows sandbox is not configured\./);
    assert(status.stdout.includes(`State directory: ${explicit}`), status.stdout);
    assert(status.stdout.includes(`Setup version: ${version}`), status.stdout);
    await absent(explicit);
    await absent(daemonHome);

    const helper = await run(["supervisor", "--setup-status", "--state-dir", explicit]);
    assert.equal(helper.code, 0, helper.stderr);
    assert.deepEqual(JSON.parse(helper.stdout), {
        ready: false,
        stateDirectory: explicit,
        setupVersion: version,
    });
    await absent(explicit);

    // The OS known-folder API is the independent reference for the real profile.
    const powershell = join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
    const profile = await invoke(
        powershell,
        [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::GetFolderPath('UserProfile')",
        ],
        options,
    );
    const expected = win32.join(profile.stdout.trim(), ".happy", "windows-sandbox");
    const defaults = await run(["sandbox", "status"], { HAPPY_WINDOWS_SANDBOX_HOME: "  " });
    assert.equal(defaults.code, 0, defaults.stderr);
    assert(defaults.stdout.includes(`State directory: ${expected}`), defaults.stdout);
    await absent(daemonHome);

    for (const args of [["setup"], ["setup", "--retry"]]) {
        const disabled = await run(["sandbox", ...args]);
        assert.equal(disabled.code, 1, disabled.stderr);
        assert.match(disabled.stderr, /disabled for this process/);
        assert.match(disabled.stderr, /Sandbox status is still available/);
        await absent(explicit);
        unavailable(
            await run(["sandbox", ...args], { HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "0" }),
            125,
        );
        await absent(explicit);
        unavailable(
            await run(["supervisor", "--setup", ...args.slice(1), "--state-dir", explicit], {
                HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "0",
            }),
            125,
        );
        await absent(explicit);
    }
    for (const state of [
        "relative/state",
        "C:relative",
        "/rooted-on-current-drive",
        "\\rooted-on-current-drive",
    ]) {
        const invalid = await run(["sandbox", "status"], { HAPPY_WINDOWS_SANDBOX_HOME: state });
        assert.equal(invalid.code, 1, invalid.stderr);
        assert.match(invalid.stderr, /absolute path/);
    }
    for (const args of [
        [],
        ["status", "--retry"],
        ["setup", "--retry", "--retry"],
        ["setup", "--force"],
        ["reset"],
    ]) {
        const invalid = await run(["sandbox", ...args]);
        assert.equal(invalid.code, 1, invalid.stderr);
        assert.match(invalid.stderr, /not valid/);
    }

    // Persisted Source records cannot establish an unimplemented native boundary.
    await mkdir(join(explicit, ".sandbox"), { recursive: true });
    await mkdir(join(explicit, ".sandbox-secrets"));
    const marker = JSON.stringify({
        version,
        offline_username: "HappySandboxOffline",
        online_username: "HappySandboxOnline",
        created_at: null,
        proxy_ports: [],
        allow_local_binding: false,
    });
    const users = JSON.stringify({
        version,
        offline: { username: "HappySandboxOffline", password: "owned-fixture-only" },
        online: { username: "HappySandboxOnline", password: "owned-fixture-only" },
    });
    const attempt = JSON.stringify({ boot_id: 1, completed_failure: true });
    await writeFile(join(explicit, ".sandbox", "setup_marker.json"), marker);
    await writeFile(join(explicit, ".sandbox", "setup-attempt.json"), attempt);
    await writeFile(join(explicit, ".sandbox-secrets", "sandbox_users.json"), users);
    const recorded = await run(["supervisor", "--setup-status", "--state-dir", explicit]);
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.equal(JSON.parse(recorded.stdout).ready, false);
    unavailable(
        await run(["sandbox", "setup", "--retry"], { HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "0" }),
        125,
    );
    assert.equal(await readFile(join(explicit, ".sandbox", "setup_marker.json"), "utf8"), marker);
    assert.equal(await readFile(join(explicit, ".sandbox", "setup-attempt.json"), "utf8"), attempt);
    assert.equal(
        await readFile(join(explicit, ".sandbox-secrets", "sandbox_users.json"), "utf8"),
        users,
    );
    await absent(daemonHome);
    console.log(
        "Windows public sandbox status, same-binary helper, state paths, disabled setup, unavailable retry, and unchanged records passed.",
    );
} finally {
    await rm(root, { recursive: true, force: true });
}
