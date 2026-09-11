import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";
import { AgentDaemonError } from "./AgentDaemonError.js";

const sandboxStatusSchema = Type.Object({
    ready: Type.Boolean(),
    stateDirectory: Type.String({ minLength: 1 }),
    setupVersion: Type.Integer({ minimum: 0 }),
});
type SandboxStatus = Static<typeof sandboxStatusSchema>;

/** Explicit Windows provisioning and read-only status use the same embedded helper as commands. */
export async function runSandboxCommand(args: readonly string[]): Promise<void> {
    const [command, ...options] = args;
    const retry = command === "setup" && options.length === 1 && options[0] === "--retry";
    if ((command !== "setup" && command !== "status") || (options.length > 0 && !retry)) {
        throw new AgentDaemonError("The Windows sandbox command is not valid.", {
            hint: "Run happy-agent sandbox status, happy-agent sandbox setup, or happy-agent sandbox setup --retry.",
        });
    }
    if (process.platform !== "win32") {
        throw new AgentDaemonError("The sandbox setup command is only needed on Windows.");
    }
    if (command === "setup" && process.env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION === "1") {
        throw new AgentDaemonError("Windows sandbox setup is disabled for this process.", {
            hint: "HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1 prevents provisioning. Sandbox status is still available.",
        });
    }

    const nativeArgs = [command === "setup" ? "--setup" : "--setup-status"];
    if (retry) nativeArgs.push("--retry");
    const explicitState = process.env.HAPPY_WINDOWS_SANDBOX_HOME?.trim();
    if (explicitState) {
        // Native code owns the canonical Windows profile path; daemon/test homes never select it.
        const root = win32.parse(explicitState).root;
        if (!win32.isAbsolute(explicitState) || root === "\\" || root === "/") {
            throw new AgentDaemonError(
                "The Windows sandbox state directory must be an absolute path.",
                {
                    hint: "Set HAPPY_WINDOWS_SANDBOX_HOME to an absolute directory or leave it unset to use the Windows profile.",
                },
            );
        }
        nativeArgs.push("--state-dir", explicitState);
    }

    const binary = resolveSupervisorBinary();
    const status = await new Promise<SandboxStatus>((resolve, reject) => {
        execFile(
            binary,
            nativeArgs,
            { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024, env: process.env },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new AgentDaemonError(
                            stderr.trim() || "The Windows sandbox helper failed.",
                            {
                                cause: error,
                                exitCode: 125,
                            },
                        ),
                    );
                    return;
                }
                try {
                    const result: unknown = JSON.parse(stdout);
                    if (!Value.Check(sandboxStatusSchema, result)) {
                        throw new Error("The sandbox status response did not match its schema.");
                    }
                    resolve(result);
                } catch (cause) {
                    reject(
                        new AgentDaemonError(
                            "The Windows sandbox helper returned an invalid status.",
                            {
                                cause,
                                hint: "Rebuild or reinstall Happy Agent with its matching native helpers.",
                                exitCode: 125,
                            },
                        ),
                    );
                }
            },
        );
    });
    console.log(
        status.ready
            ? "Happy's Windows sandbox is configured."
            : "Happy's Windows sandbox is not configured.",
    );
    console.log("State directory: " + status.stateDirectory);
    console.log("Setup version: " + status.setupVersion);
    if (!status.ready) console.log("Run happy-agent sandbox setup to initialize it.");
}
