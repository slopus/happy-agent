import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorCommand } from "../../sources/supervisor/createSupervisorCommand.js";

afterEach(() => vi.unstubAllEnvs());
const options = {
    command: "echo hello",
    cwd: "C:\\project",
    platform: "win32" as const,
    policy: {
        mode: "read_only" as const,
        network: { egress: false, localBinding: false, allowedHosts: [] },
    },
    shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    supervisorPath: "C:\\Happy\\happy-agent-supervisor.exe",
};

describe("Windows supervisor setup selection", () => {
    it("leaves the installation default to Windows rather than app or test homes", () => {
        const result = createSupervisorCommand({
            ...options,
            environment: {
                HAPPY_HOME_DIR: "C:\\one-app",
                HOME: "C:\\fake-home",
                USERPROFILE: "C:\\other-test",
            },
        });
        expect(result.args).not.toContain("--state-dir");
        expect(result.args).not.toContain("C:\\one-app");
        expect(result.args).toContain("C:\\project");
    });
    it("forwards an explicitly selected development installation", () => {
        const result = createSupervisorCommand({
            ...options,
            environment: { HAPPY_WINDOWS_SANDBOX_HOME: " C:\\approved-state " },
        });
        expect(
            result.args.slice(
                result.args.indexOf("--state-dir"),
                result.args.indexOf("--state-dir") + 2,
            ),
        ).toEqual(["--state-dir", "C:\\approved-state"]);
    });
    it("cannot lose the unattended no-provision boundary through a replacement environment", () => {
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_NO_PROVISION", "1");
        expect(createSupervisorCommand({ ...options, environment: {} }).args).toContain(
            "--no-provision",
        );
        expect(
            createSupervisorCommand({
                ...options,
                environment: { HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "0" },
            }).args,
        ).toContain("--no-provision");
    });
    it("honors the supplied no-provision boundary independently of ambient variables", () => {
        vi.stubEnv("HAPPY_WINDOWS_SANDBOX_NO_PROVISION", "0");
        expect(
            createSupervisorCommand({
                ...options,
                environment: { HAPPY_WINDOWS_SANDBOX_NO_PROVISION: "1" },
            }).args,
        ).toContain("--no-provision");
    });
});
