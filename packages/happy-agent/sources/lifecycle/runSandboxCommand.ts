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
const sandboxJsonStatusSchema = Type.Object(
    {
        status: Type.Union([Type.Literal("ready"), Type.Literal("required")]),
        setupVersion: Type.Integer({ minimum: 0 }),
        previousAttempt: Type.Optional(
            Type.Union([Type.Literal("cancelled"), Type.Literal("failed")]),
        ),
    },
    { additionalProperties: false },
);
const sandboxJsonSetupSchema = Type.Object(
    {
        status: Type.Union([
            Type.Literal("ready"),
            Type.Literal("cancelled"),
            Type.Literal("failed"),
        ]),
        setupVersion: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

/** Explicit Windows provisioning and read-only status use the same embedded helper as commands. */
export async function runSandboxCommand(args: readonly string[]): Promise<void> {
    const [command, ...options] = args;
    const json = options.includes("--json");
    const retry = options.includes("--retry");
    if (
        (command !== "setup" && command !== "status") ||
        new Set(options).size !== options.length ||
        options.some((option) => option !== "--json" && option !== "--retry") ||
        (retry && command !== "setup")
    ) {
        throw new AgentDaemonError("The Windows sandbox command is not valid.", {
            hint: "Run happy-agent sandbox status [--json] or happy-agent sandbox setup [--retry] [--json].",
        });
    }
    if (process.platform !== "win32") {
        if (json) {
            console.log(JSON.stringify({ status: "ready", setupVersion: 0 }));
            return;
        }
        throw new AgentDaemonError("The sandbox setup command is only needed on Windows.");
    }

    try {
        const result = await invokeSandboxHelper(command, retry, json);
        if (json) {
            const status: unknown = JSON.parse(result.stdout);
            const schema = command === "status" ? sandboxJsonStatusSchema : sandboxJsonSetupSchema;
            if (!Value.Check(schema, status)) {
                throw new Error("The Windows sandbox helper returned an invalid JSON result.");
            }
            // A typed setup failure is still a complete JSON response, even when the helper
            // exits 125. Callers use its status rather than parsing diagnostic prose.
            if (result.error && result.stderr.trim()) console.error(result.stderr.trim());
            console.log(JSON.stringify(status));
            return;
        }
        if (result.error) {
            throw new AgentDaemonError(
                result.stderr.trim() || "The Windows sandbox helper failed.",
                { cause: result.error, exitCode: 125 },
            );
        }
        let status: SandboxStatus;
        try {
            const value: unknown = JSON.parse(result.stdout);
            if (!Value.Check(sandboxStatusSchema, value)) {
                throw new Error("The sandbox status response did not match its schema.");
            }
            status = value;
        } catch (cause) {
            throw new AgentDaemonError("The Windows sandbox helper returned an invalid status.", {
                cause,
                hint: "Rebuild or reinstall Happy Agent with its matching native helpers.",
                exitCode: 125,
            });
        }
        console.log(
            status.ready
                ? "Happy's Windows sandbox is configured."
                : "Happy's Windows sandbox is not configured.",
        );
        console.log("State directory: " + status.stateDirectory);
        console.log("Setup version: " + status.setupVersion);
        if (!status.ready) console.log("Run happy-agent sandbox setup to initialize it.");
    } catch (error: unknown) {
        if (!json) throw error;
        console.error(error instanceof Error ? error.message : String(error));
        console.log(
            JSON.stringify({
                status: command === "status" ? "required" : "failed",
                setupVersion: 0,
            }),
        );
    }
}

async function invokeSandboxHelper(command: "setup" | "status", retry: boolean, json: boolean) {
    if (command === "setup" && process.env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION === "1") {
        throw new AgentDaemonError("Windows sandbox setup is disabled for this process.", {
            hint: "HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1 prevents provisioning. Sandbox status is still available.",
        });
    }

    const nativeArgs = [command === "setup" ? "--setup" : "--setup-status"];
    if (retry) nativeArgs.push("--retry");
    if (json) nativeArgs.push("--json");
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
    return await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
        execFile(
            binary,
            nativeArgs,
            { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024, env: process.env },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }),
        );
    });
}
