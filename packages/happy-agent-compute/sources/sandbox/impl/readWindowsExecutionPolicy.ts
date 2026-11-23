import { execFile } from "node:child_process";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { resolveSystemShell } from "../../processes/impl/resolveSystemShell.js";
import { shellEnvironment } from "../../processes/impl/shellEnvironment.js";

const windowsExecutionPolicySchema = Type.Union([
    Type.Literal("Restricted"),
    Type.Literal("AllSigned"),
    Type.Literal("RemoteSigned"),
    Type.Literal("Unrestricted"),
    Type.Literal("Bypass"),
]);

export type WindowsExecutionPolicy = Static<typeof windowsExecutionPolicySchema>;

/** How long the one-time policy probe may take before restricted commands go on without it. */
const POLICY_PROBE_TIMEOUT_MS = 10_000;

let effectivePolicy: Promise<WindowsExecutionPolicy | undefined> | undefined;

/**
 * The execution policy Windows PowerShell applies to the person this process runs as.
 *
 * Read once per process: a probe costs a PowerShell start, and the policy is a machine and user
 * setting that rarely changes. A probe that fails or times out yields `undefined`, which leaves
 * restricted commands on the sandbox account's own policy, as before.
 */
export function readWindowsExecutionPolicy(): Promise<WindowsExecutionPolicy | undefined> {
    effectivePolicy ??= new Promise((resolve) => {
        const shell = resolveSystemShell();
        execFile(
            shell,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
            {
                env: shellEnvironment(shell, process.env),
                timeout: POLICY_PROBE_TIMEOUT_MS,
                windowsHide: true,
            },
            (error, stdout) => {
                const policy = String(stdout).trim();
                resolve(
                    error === null && Value.Check(windowsExecutionPolicySchema, policy)
                        ? policy
                        : undefined,
                );
            },
        );
    });
    return effectivePolicy;
}
