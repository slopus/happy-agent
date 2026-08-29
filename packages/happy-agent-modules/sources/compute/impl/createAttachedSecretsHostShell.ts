import { homedir } from "node:os";

import {
    createHostShell,
    MAX_ACTIVE_HOST_SESSIONS,
    MAX_RETAINED_HOST_SESSIONS,
    type ComputeHostPolicy,
    type ComputeRunOptions,
    type ComputeSessionExit,
    type ComputeSessionSnapshot,
    type ComputeShell,
    type NativeProcessManager,
} from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import { GLOBAL_SECRET_OWNER_ID, type SecretsModule } from "../../secrets/index.js";

interface AttachedSecretsHostSession {
    active: boolean;
    readonly command: string;
    readonly commandShell: ComputeShell;
    cwd: string;
    evicted: boolean;
    exited: boolean;
    innerSessionId: number;
    readonly sessionId: number;
    readonly usesSecrets: boolean;
}

export interface AttachedSecretsHostShellOptions {
    readonly agentId: string;
    readonly ctx: Context;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly hostPolicy: ComputeHostPolicy;
    readonly processManager: NativeProcessManager;
    readonly secrets: SecretsModule;
}

/**
 * Adds agent-scoped attachments from the global secret catalog to the published host shell without
 * handing values to the compute contract.
 *
 * The published shell deliberately accepts only bundle IDs and rejects them until an agent-layer
 * resolver is present. This adapter is that resolver. Each command gets a fresh host shell whose
 * fixed environment is scrubbed as soon as the process has spawned; public session IDs route later
 * reads, input, and stops back to the one-command shell that owns the process.
 */
export function createAttachedSecretsHostShell(
    options: AttachedSecretsHostShellOptions,
): ComputeShell {
    const sessions = new Map<number, AttachedSecretsHostSession>();
    let nextSessionId = 1;
    let pendingSessionStarts = 0;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;

    const activeSessions = () =>
        [...sessions.values()]
            .filter((session) => session.active && !session.evicted)
            .map((session) => ({
                command: session.command,
                cwd: session.cwd,
                sessionId: session.sessionId,
                status: "running" as const,
            }));
    const activeSessionCount = () => activeSessions().length;
    const notifyActiveSessionCount = () => onActiveSessionCountChange?.(activeSessionCount());

    const finishSession = (session: AttachedSecretsHostSession): void => {
        if (!session.active && session.exited) return;
        session.active = false;
        session.exited = true;
        notifyActiveSessionCount();
        trimFinishedSessions();
    };

    const trimFinishedSessions = (): void => {
        while (sessions.size > MAX_RETAINED_HOST_SESSIONS) {
            const finished = [...sessions.values()]
                .filter((session) => !session.active)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            finished.commandShell.setActiveSessionCountListener?.(undefined);
            finished.commandShell.setSessionExitListener?.(undefined);
            sessions.delete(finished.sessionId);
        }
    };

    const reserveSessionStart = (): (() => void) => {
        while (activeSessionCount() + pendingSessionStarts >= MAX_ACTIVE_HOST_SESSIONS) {
            const oldest = [...sessions.values()]
                .filter((session) => session.active && !session.evicted)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) {
                throw new Error(
                    `No more than ${String(MAX_ACTIVE_HOST_SESSIONS)} background commands can run at once.`,
                );
            }
            oldest.evicted = true;
            notifyActiveSessionCount();
            void oldest.commandShell
                .killSession(oldest.innerSessionId)
                .then(() => finishSession(oldest))
                .catch((error: unknown) => {
                    options.ctx.log.warn(
                        "Compute could not stop the oldest secret-aware background command.",
                        { sessionId: oldest.sessionId },
                        error,
                    );
                });
        }
        pendingSessionStarts += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            pendingSessionStarts -= 1;
        };
    };

    const commandShell = async (
        runOptions: ComputeRunOptions,
    ): Promise<{ readonly environment: NodeJS.ProcessEnv; readonly shell: ComputeShell }> => {
        const selected = runOptions.secrets ?? [];
        const resolved = await options.secrets.resolveForCommand(
            options.ctx,
            GLOBAL_SECRET_OWNER_ID,
            options.agentId,
            selected,
        );
        const environment = mergeCommandEnvironment(
            options.environment ?? process.env,
            resolved.environment,
            resolved.hiddenEnvironmentVariables,
        );
        return {
            environment,
            shell: createHostShell({
                ctx: options.ctx,
                cwd: options.cwd,
                environment,
                homeDirectory: homedir(),
                hostPolicy: options.hostPolicy,
                maxActiveSessions: 1,
                maxRetainedSessions: 1,
                processManager: options.processManager,
            }),
        };
    };

    const publicSnapshot = (
        session: AttachedSecretsHostSession,
        snapshot: ComputeSessionSnapshot,
    ): ComputeSessionSnapshot => ({ ...snapshot, sessionId: session.sessionId });

    return {
        cwd: options.cwd,
        activeSessionCount,
        activeSessions,
        detachSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session !== undefined) {
                session.commandShell.detachSession?.(session.innerSessionId);
            }
        },
        async interruptSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            return await session.commandShell.interruptSession?.(session.innerSessionId);
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => session.active);
            await Promise.all(
                active.map(async (session) => {
                    const snapshot = await session.commandShell.killSession(session.innerSessionId);
                    if (snapshot === undefined || snapshot.status !== "running") {
                        finishSession(session);
                    }
                }),
            );
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            const snapshot = await session.commandShell.killSession(session.innerSessionId);
            if (snapshot === undefined) {
                finishSession(session);
                return undefined;
            }
            if (snapshot.status !== "running") finishSession(session);
            return publicSnapshot(session, snapshot);
        },
        async readSession(sessionId, readOptions) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            const snapshot = await session.commandShell.readSession(
                session.innerSessionId,
                readOptions,
            );
            if (snapshot === undefined) return undefined;
            if (snapshot.status !== "running") finishSession(session);
            return publicSnapshot(session, snapshot);
        },
        async run(runOptions) {
            const created = await commandShell(runOptions);
            try {
                return await created.shell.run(withoutSecretIds(runOptions));
            } finally {
                clearEnvironment(created.environment);
            }
        },
        sessionUsesSecrets(sessionId) {
            return sessions.get(sessionId)?.usesSecrets === true;
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        setSessionExitListener(listener) {
            onSessionExit = listener;
        },
        async startSession(runOptions) {
            const created = await commandShell(runOptions);
            let releaseSessionStart: () => void;
            try {
                releaseSessionStart = reserveSessionStart();
            } catch (error) {
                clearEnvironment(created.environment);
                throw error;
            }
            const sessionId = nextSessionId;
            nextSessionId += 1;
            const session: AttachedSecretsHostSession = {
                active: false,
                command: runOptions.command,
                commandShell: created.shell,
                cwd: runOptions.cwd ?? options.cwd,
                evicted: false,
                exited: false,
                innerSessionId: 0,
                sessionId,
                usesSecrets: (runOptions.secrets?.length ?? 0) > 0,
            };
            sessions.set(sessionId, session);
            created.shell.setSessionExitListener?.((exit) => {
                finishSession(session);
                return onSessionExit?.({ ...exit, sessionId });
            });
            try {
                session.innerSessionId = await created.shell.startSession(
                    withoutSecretIds(runOptions),
                );
                session.active = !session.exited;
                session.cwd =
                    created.shell
                        .activeSessions?.()
                        .find((candidate) => candidate.sessionId === session.innerSessionId)?.cwd ??
                    session.cwd;
                notifyActiveSessionCount();
                trimFinishedSessions();
                return sessionId;
            } catch (error) {
                sessions.delete(sessionId);
                throw error;
            } finally {
                clearEnvironment(created.environment);
                releaseSessionStart();
            }
        },
        supportsSessionInput: true,
        async writeSession(permissions, sessionId, data) {
            const session = sessions.get(sessionId);
            if (session === undefined) return false;
            return await session.commandShell.writeSession(
                permissions,
                session.innerSessionId,
                data,
            );
        },
    };
}

function withoutSecretIds<Options extends ComputeRunOptions>(options: Options): Options {
    const { secrets: _secrets, ...rest } = options;
    return rest as Options;
}

function mergeCommandEnvironment(
    ambient: NodeJS.ProcessEnv,
    selected: Readonly<Record<string, string>>,
    hiddenNames: readonly string[],
): NodeJS.ProcessEnv {
    const hidden = new Set(hiddenNames.map((name) => name.toUpperCase()));
    const environment = Object.create(null) as NodeJS.ProcessEnv;
    for (const [name, value] of Object.entries(ambient)) {
        if (value !== undefined && !hidden.has(name.toUpperCase())) environment[name] = value;
    }
    for (const [name, value] of Object.entries(selected)) environment[name] = value;
    return environment;
}

function clearEnvironment(environment: NodeJS.ProcessEnv): void {
    for (const name of Object.keys(environment)) delete environment[name];
}
