import { delimiter, resolve } from "node:path";

import type { ComputeHostPolicy } from "../../ComputeHostPolicy.js";
import type { ComputePermissionMode } from "../../ComputePermissions.js";
import { findExecutableSearchPaths } from "./findExecutableSearchPaths.js";
import { createShellEnvironment } from "./createShellEnvironment.js";
import { readWindowsExecutionPolicy } from "./readWindowsExecutionPolicy.js";

export async function createToolEnvironment(
    mode: ComputePermissionMode,
    environment: NodeJS.ProcessEnv = process.env,
    options: {
        cwd?: string;
        hostPolicy?: ComputeHostPolicy;
        homeDirectory?: string;
        temporaryDirectory?: string;
    } = {},
): Promise<NodeJS.ProcessEnv> {
    const filtered = createShellEnvironment(environment, options.hostPolicy);
    if (mode === "full_access") return filtered;
    if (process.platform === "win32") {
        // Restricted commands run as Happy's separate Windows account. Trust
        // only the selected workspace for Git ownership checks, scoped to this
        // process environment. Never change the user's global Git config or
        // trust every repository on the machine.
        const configuredCount = Number(filtered.GIT_CONFIG_COUNT ?? "0");
        const count =
            Number.isSafeInteger(configuredCount) && configuredCount >= 0 ? configuredCount : 0;
        // That account has no execution policy of its own, so Windows PowerShell falls back to
        // the machine default, which is Restricted on Windows clients, and refuses npm.ps1,
        // pnpm.ps1, and the project's own scripts that the person's shell runs. Carry the
        // person's effective policy at process scope; Group Policy still overrides it.
        const executionPolicy = Object.keys(filtered).some(
            (name) => name.toLowerCase() === "psexecutionpolicypreference",
        )
            ? undefined
            : await readWindowsExecutionPolicy();
        return {
            ...filtered,
            ...(executionPolicy === undefined
                ? {}
                : { PSExecutionPolicyPreference: executionPolicy }),
            GIT_CONFIG_COUNT: String(count + 1),
            [`GIT_CONFIG_KEY_${count}`]: "safe.directory",
            [`GIT_CONFIG_VALUE_${count}`]: resolve(options.cwd ?? process.cwd()).replaceAll(
                "\\",
                "/",
            ),
        };
    }
    return {
        ...filtered,
        PATH: (
            await findExecutableSearchPaths({
                cwd: options.cwd ?? process.cwd(),
                environment,
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
                ...(options.temporaryDirectory === undefined
                    ? {}
                    : { temporaryDirectory: options.temporaryDirectory }),
            })
        ).join(delimiter),
    };
}
