import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFile, resolveSupervisorBinary } = vi.hoisted(() => ({
    execFile: vi.fn(),
    resolveSupervisorBinary: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("@slopus/happy-agent-supervisor", () => ({ resolveSupervisorBinary }));

import { runSandboxCommand } from "../sources/lifecycle/runSandboxCommand.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const ready = {
    ready: true,
    stateDirectory: "C:/Users/real/.happy/windows-sandbox",
    setupVersion: 8,
};

describe("Windows sandbox command", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        Object.defineProperty(process, "platform", { value: "win32" });
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_NO_PROVISION", undefined);
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_HOME", undefined);
        vi.spyOn(console, "log").mockImplementation(() => {});
        resolveSupervisorBinary.mockReturnValue("C:/cache/Happy Supervisor.exe");
        execFile.mockImplementation((_file, _args, _options, callback) =>
            callback(null, JSON.stringify(ready), ""),
        );
    });
    afterEach(() => {
        Object.defineProperty(process, "platform", originalPlatform);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("uses the matching resolved supervisor without deriving state from environment homes", async () => {
        vi.stubEnv("HAPPY_HOME_DIR", "C:/isolated-daemon/.happy");
        vi.stubEnv("HOME", "C:/untrusted-home");
        vi.stubEnv("USERPROFILE", "C:/untrusted-profile");
        await runSandboxCommand(["setup"]);
        expect(resolveSupervisorBinary).toHaveBeenCalledExactlyOnceWith();
        expect(execFile).toHaveBeenCalledExactlyOnceWith(
            "C:/cache/Happy Supervisor.exe",
            ["--setup"],
            { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024, env: process.env },
            expect.any(Function),
        );
        expect(console.log).toHaveBeenCalledWith("Happy's Windows sandbox is configured.");
    });

    it("forwards retry only when explicitly requested and preserves a spaced state path", async () => {
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_HOME", "  C:/Happy Shared/state  ");
        await runSandboxCommand(["setup", "--retry"]);
        expect(execFile.mock.calls[0]?.[1]).toEqual([
            "--setup",
            "--retry",
            "--state-dir",
            "C:/Happy Shared/state",
        ]);
    });

    it("ignores an empty explicit state override", async () => {
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_HOME", "  ");
        await runSandboxCommand(["status"]);
        expect(execFile.mock.calls[0]?.[1]).toEqual(["--setup-status"]);
    });

    it("allows read-only status while provisioning is prohibited", async () => {
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_NO_PROVISION", "1");
        execFile.mockImplementation((_file, _args, _options, callback) =>
            callback(null, JSON.stringify({ ...ready, ready: false }), ""),
        );
        await runSandboxCommand(["status"]);
        expect(execFile.mock.calls[0]?.[1]).toEqual(["--setup-status"]);
        expect(console.log).toHaveBeenCalledWith("Happy's Windows sandbox is not configured.");
    });

    it.each([["setup"], ["setup", "--retry"]])(
        "never resolves or launches setup when prohibited: %j",
        async (...args) => {
            vi.stubEnv("HAPPY_WINDOWS_SANDBOX_NO_PROVISION", "1");
            await expect(runSandboxCommand(args)).rejects.toThrow("disabled for this process");
            expect(resolveSupervisorBinary).not.toHaveBeenCalled();
            expect(execFile).not.toHaveBeenCalled();
        },
    );

    it.each([
        [],
        ["status", "--retry"],
        ["setup", "--retry", "--retry"],
        ["setup", "--force"],
        ["reset"],
    ])("rejects invalid commands before resolution: %j", async (...args) => {
        await expect(runSandboxCommand(args)).rejects.toThrow("not valid");
        expect(resolveSupervisorBinary).not.toHaveBeenCalled();
        expect(execFile).not.toHaveBeenCalled();
    });

    it.each(["relative/state", "C:relative", "/rooted-on-current-drive"])(
        "rejects state without a fully qualified path: %s",
        async (state) => {
            vi.stubEnv("HAPPY_WINDOWS_SANDBOX_HOME", state);
            await expect(runSandboxCommand(["setup"])).rejects.toThrow("absolute path");
            expect(execFile).not.toHaveBeenCalled();
        },
    );

    it("does not start Windows helpers on another platform", async () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        await expect(runSandboxCommand(["status"])).rejects.toThrow("only needed on Windows");
        expect(resolveSupervisorBinary).not.toHaveBeenCalled();
    });

    it("preserves the native failure as exit 125 and does not retry it", async () => {
        execFile.mockImplementation((_file, _args, _options, callback) =>
            callback(
                new Error("exit 125"),
                "",
                "A previous setup attempt failed. Use happy-agent sandbox setup --retry.\n",
            ),
        );
        await expect(runSandboxCommand(["setup"])).rejects.toMatchObject({
            message: "A previous setup attempt failed. Use happy-agent sandbox setup --retry.",
            exitCode: 125,
        });
        expect(execFile).toHaveBeenCalledTimes(1);
        expect(console.log).not.toHaveBeenCalled();
    });

    it.each([
        "not JSON",
        JSON.stringify({ ...ready, ready: "yes" }),
        JSON.stringify({ ready: true }),
    ])("rejects an invalid native response: %s", async (response) => {
        execFile.mockImplementation((_file, _args, _options, callback) =>
            callback(null, response, ""),
        );
        await expect(runSandboxCommand(["status"])).rejects.toMatchObject({ exitCode: 125 });
        expect(console.log).not.toHaveBeenCalled();
    });
});
