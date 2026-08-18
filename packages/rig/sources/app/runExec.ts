import { findLastAgentResponseText } from "./findLastAgentResponseText.js";
import { errorToMessage } from "../errorToMessage.js";
import { ensureLocalProtocolServer } from "../client/index.js";
import { loadConfig } from "../config/index.js";
import type {
    CreateSessionRequest,
    PermissionMode,
    ProtocolSession,
    ServiceTier,
    SessionEvent,
    StopReason,
} from "../protocol/index.js";
import { parsePermissionMode } from "./parsePermissionMode.js";
import type { ExecCommandOptions } from "./parseExecCommand.js";
import { readExecPrompt } from "./readExecPrompt.js";
import { resolveSessionSelection } from "./resolveSessionSelection.js";
import { RigUserError } from "../RigUserError.js";

export async function runExec(
    options: ExecCommandOptions,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    let debugDirectory: string | undefined;
    try {
        await run(options, environment, (directory) => {
            debugDirectory = directory;
        });
    } catch (error) {
        if (options.outputFormat === "text") throw error;
        const payload = {
            ...(debugDirectory === undefined ? {} : { debugDirectory }),
            error: errorToMessage(error),
            type: "error",
        };
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        process.exitCode = 1;
    }
}

async function run(
    options: ExecCommandOptions,
    environment: NodeJS.ProcessEnv,
    onDebugDirectory: (directory: string) => void,
): Promise<void> {
    const cwd = process.cwd();
    const prompt = await readExecPrompt(options.prompt);
    const loadedConfig = await loadConfig({ cwd, env: environment });
    const connection = await ensureLocalProtocolServer(
        options.outputFormat === "text"
            ? { onStatus: (message: string) => process.stderr.write(`${message}\n`) }
            : {},
    );

    const opened = await openSession(
        options,
        cwd,
        loadedConfig.config.defaults,
        connection.client,
        environment,
    );
    let session = opened.session;
    if (options.fork) {
        session = (await connection.client.forkSession(session.id)).session;
    }

    const sessionTerminal = await connection.client.connectSessionTerminal(session.id);
    try {
        const submitted = await connection.client.submitMessage(session.id, {
            ...(options.debug === true ? { debug: true } : {}),
            // A resumed session keeps running on what it already runs on unless this invocation
            // said otherwise; a new one was just created with exactly these values.
            effort: (opened.resumed ? options.effort : undefined) ?? session.effort ?? "medium",
            interactive: false,
            modelId: (opened.resumed ? options.modelId : undefined) ?? session.modelId,
            ...(opened.resumed && options.permissionMode !== undefined
                ? { permissionMode: options.permissionMode }
                : {}),
            providerId: (opened.resumed ? options.providerId : undefined) ?? session.providerId,
            serviceTier: session.serviceTier ?? null,
            text: prompt,
        });
        if (submitted.debugDirectory !== undefined) onDebugDirectory(submitted.debugDirectory);
        if (options.outputFormat === "text" && submitted.debugDirectory !== undefined) {
            process.stderr.write(`Debug log: ${submitted.debugDirectory}\n`);
        }
        const controller = new AbortController();
        let failure: string | undefined;
        let stopReason: StopReason | undefined;
        const abort = () => {
            stopReason = "aborted";
            void connection.client.abort(session.id);
            controller.abort();
        };
        process.once("SIGINT", abort);
        try {
            await connection.client.watchSessionEvents({
                after: submitted.eventId,
                sessionId: session.id,
                signal: controller.signal,
                async onEvent(event) {
                    if (options.outputFormat === "stream-json") {
                        await writeStdout(`${JSON.stringify({ event, type: "event" })}\n`);
                    }
                    if (event.type === "user_input_requested") {
                        failure = "The agent requested interactive input during a headless run.";
                        void connection.client.abort(session.id);
                        controller.abort();
                        return;
                    }
                    if (!belongsToRun(event, submitted.runId)) return;
                    if (event.type === "run_error") {
                        failure = event.data.errorMessage;
                        controller.abort();
                    } else if (event.type === "run_finished") {
                        stopReason = event.data.stopReason;
                        controller.abort();
                    }
                },
            });
        } finally {
            process.off("SIGINT", abort);
        }

        const completed = (await connection.client.getSession(session.id)).session;
        const response = findLastAgentResponseText(completed.snapshot.messages) ?? "";
        if (failure !== undefined) {
            emitFailure(
                options.outputFormat,
                failure,
                completed.id,
                submitted.runId,
                submitted.debugDirectory,
            );
            process.exitCode = 1;
            return;
        }

        const result = {
            ...(submitted.debugDirectory === undefined
                ? {}
                : { debugDirectory: submitted.debugDirectory }),
            response,
            runId: submitted.runId,
            sessionId: completed.id,
            stopReason: stopReason ?? "error",
            type: "result",
        };
        if (options.outputFormat === "text") {
            process.stdout.write(
                response.length === 0 || response.endsWith("\n") ? response : `${response}\n`,
            );
        } else {
            process.stdout.write(`${JSON.stringify(result)}\n`);
        }
        if (result.stopReason === "error" || result.stopReason === "aborted") process.exitCode = 1;
    } finally {
        await sessionTerminal.close().catch(() => undefined);
    }
}

export async function writeStdout(value: string): Promise<void> {
    if (process.stdout.write(value)) return;
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            process.stdout.off("close", onClose);
            process.stdout.off("drain", onDrain);
            process.stdout.off("error", onError);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("Standard output closed before Rig could write the event."));
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        process.stdout.once("close", onClose);
        process.stdout.once("drain", onDrain);
        process.stdout.once("error", onError);
    });
}

async function openSession(
    options: ExecCommandOptions,
    cwd: string,
    defaults: {
        effort?: string;
        instructions?: string;
        modelId: string;
        permissionMode: PermissionMode;
        providerId?: string;
        serviceTier?: ServiceTier;
    },
    client: Awaited<ReturnType<typeof ensureLocalProtocolServer>>["client"],
    environment: NodeJS.ProcessEnv,
): Promise<{ readonly resumed: boolean; readonly session: ProtocolSession }> {
    let sessionId = options.resumeSessionId;
    if (options.last) {
        const listed = await client.listSessions();
        sessionId = listed.sessions.find((session) => session.cwd === cwd)?.id;
        if (sessionId === undefined) {
            throw new RigUserError("Rig has no saved sessions in this directory.", {
                hint: "Pass --resume <session-id> to name one explicitly.",
            });
        }
    }
    if (sessionId !== undefined) {
        return { resumed: true, session: (await client.getSession(sessionId)).session };
    }

    const providerId = options.providerId ?? environment.RIG_PROVIDER ?? defaults.providerId;
    const effort = options.effort ?? environment.RIG_EFFORT ?? defaults.effort;
    // The agent chooses nothing, so the catalog it published completes whatever this invocation
    // and the configuration left unsaid.
    const catalog = (await client.models()).catalog;
    const selection = resolveSessionSelection(
        {
            modelId: options.modelId ?? environment.RIG_MODEL ?? defaults.modelId,
            ...(providerId === undefined ? {} : { providerId }),
            ...(effort === undefined ? {} : { effort }),
            ...(defaults.serviceTier === undefined ? {} : { serviceTier: defaults.serviceTier }),
        },
        catalog,
    );
    const request: CreateSessionRequest = {
        cwd,
        ...selection,
        // Read the same way the model and provider are. An exec run that asked for a narrower
        // mode and silently got the default would be given reach it was told it would not have.
        permissionMode:
            options.permissionMode ??
            (environment.RIG_PERMISSION_MODE === undefined
                ? undefined
                : parsePermissionMode(environment.RIG_PERMISSION_MODE)) ??
            defaults.permissionMode,
    };
    const instructions = defaults.instructions;
    if (instructions !== undefined) request.instructions = instructions;
    return { resumed: false, session: (await client.createSession(request)).session };
}

function belongsToRun(event: SessionEvent, runId: string): boolean {
    return "runId" in event.data && event.data.runId === runId;
}

function emitFailure(
    outputFormat: ExecCommandOptions["outputFormat"],
    error: string,
    sessionId: string,
    runId: string,
    debugDirectory?: string,
): void {
    if (outputFormat === "text") {
        process.stderr.write(`${error}\n`);
        return;
    }
    process.stdout.write(
        `${JSON.stringify({ ...(debugDirectory === undefined ? {} : { debugDirectory }), error, runId, sessionId, type: "error" })}\n`,
    );
}
