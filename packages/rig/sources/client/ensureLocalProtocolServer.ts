import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    AgentDaemonError,
    ensureAgentDaemon,
    readTokenIfPresent as readAgentDaemonTokenIfPresent,
    type AgentDaemonConnection,
    type AgentDaemonRestartRequest,
} from "@slopus/happy-agent";

import { RigUserError } from "../RigUserError.js";

export type DaemonRestartRequest = AgentDaemonRestartRequest;
export type LocalProtocolServerConnection = AgentDaemonConnection;

export interface EnsureLocalProtocolServerOptions {
    confirmRestart?: (request: DaemonRestartRequest) => Promise<boolean>;
    onStatus?: (message: string) => void;
}

/**
 * Connects to the local Happy agent daemon, starting one when none is running.
 *
 * The daemon owns its whole boot sequence in `@slopus/happy-agent`; Rig only says which script
 * runs a replacement daemon and presents lifecycle failures the Rig way.
 */
export async function ensureLocalProtocolServer(
    options: EnsureLocalProtocolServerOptions = {},
): Promise<LocalProtocolServerConnection> {
    const entrypoint = resolveAgentDaemonEntrypoint();
    try {
        return await ensureAgentDaemon({
            ...options,
            ...(entrypoint === undefined ? {} : { entrypoint }),
        });
    } catch (error) {
        throw toRigError(error);
    }
}

export async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    return readAgentDaemonTokenIfPresent(tokenPath);
}

/**
 * Locates the script that runs the Happy agent daemon (`node <script> run`).
 *
 * A released Rig ships the bundled daemon CLI as `agent.js` beside its own bundle. A source
 * checkout has no bundle, so the daemon CLI is resolved from the installed
 * `@slopus/happy-agent` package instead.
 */
export function resolveAgentDaemonEntrypoint(): string | undefined {
    const bundled = new URL("./agent.js", import.meta.url);
    if (bundled.protocol === "file:" && existsSync(bundled)) return fileURLToPath(bundled);
    try {
        return fileURLToPath(import.meta.resolve("@slopus/happy-agent/cli"));
    } catch {
        return undefined;
    }
}

export function toRigError(error: unknown): unknown {
    if (!(error instanceof AgentDaemonError)) return error;
    return new RigUserError(error.message, {
        ...(error.cause === undefined ? {} : { cause: error.cause }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
}
