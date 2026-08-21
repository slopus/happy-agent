import type {
    Agent,
    DaemonConfig,
    HappyAgentClient,
    Message,
    MessageMode,
    Run,
} from "@slopus/happy-agent-client";

import {
    ensureLocalProtocolServer,
    ensureWorkspaceForCwd,
    HappyAgentEventHub,
    loadAgentCatalog,
} from "../client/index.js";
import { loadConfig } from "../config/index.js";
import { errorToMessage } from "../errorToMessage.js";
import type { PermissionMode } from "../protocol/index.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { parsePermissionMode } from "./parsePermissionMode.js";
import type { ExecCommandOptions } from "./parseExecCommand.js";
import { readExecPrompt } from "./readExecPrompt.js";

export async function runExec(
    options: ExecCommandOptions,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    try {
        await run(options, environment);
    } catch (error) {
        if (options.outputFormat === "text") throw error;
        process.stdout.write(
            `${JSON.stringify({ error: errorToMessage(error), type: "error" })}\n`,
        );
        process.exitCode = 1;
    }
}

async function run(options: ExecCommandOptions, environment: NodeJS.ProcessEnv): Promise<void> {
    const cwd = process.cwd();
    const prompt = await readExecPrompt(options.prompt);
    const loadedConfig = await loadConfig({ cwd, env: environment });
    const connection = await ensureLocalProtocolServer(
        options.outputFormat === "text"
            ? { onStatus: (message: string) => process.stderr.write(`${message}\n`) }
            : {},
    );
    const config = (await connection.client.getConfig()).config;
    const opened = await openAgent(options, cwd, connection.client);
    const bootstrap = await connection.client.getAgentBootstrap(opened.id);
    const events = new HappyAgentEventHub(connection.client, bootstrap.cursor);
    events.start();
    const mode = resolveMode(
        options,
        environment,
        loadedConfig.config.defaults,
        config,
        bootstrap.mode,
    );
    const submitted = await connection.client.sendMessage(opened.id, {
        delivery: "queue",
        mode,
        text: prompt,
    });

    const controller = new AbortController();
    let activeRunId = submitted.message.runId;
    let terminalRun: Run | undefined;
    let failure: string | undefined;
    const abort = () => {
        void connection.client
            .abortAgent(opened.id, {
                ...(activeRunId === null ? {} : { expectedRunId: activeRunId }),
            })
            .catch(() => undefined);
        controller.abort();
    };
    process.once("SIGINT", abort);
    try {
        await events.follow({
            after: submitted.cursor,
            signal: controller.signal,
            onGap: async () => {
                const history = await connection.client.getMessages(opened.id, { limit: 50 });
                const recovered = history.runs.find((run) =>
                    run.messages.some((message) => message.id === submitted.message.id),
                );
                if (recovered === undefined) return;
                activeRunId = recovered.id;
                if (recovered.status !== "running") {
                    terminalRun = recovered;
                    controller.abort();
                }
            },
            onEvent: async (event) => {
                if (options.outputFormat === "stream-json") {
                    process.stdout.write(`${JSON.stringify({ event, type: "event" })}\n`);
                }
                if (
                    event.type === "question.created" &&
                    event.payload.question.agentId === opened.id
                ) {
                    failure = "The agent requested interactive input during a headless run.";
                    await connection.client.abortAgent(opened.id).catch(() => undefined);
                    return true;
                }
                if (
                    event.type === "run.started" &&
                    event.payload.agentId === opened.id &&
                    event.payload.acceptedMessageIds.includes(submitted.message.id)
                ) {
                    activeRunId = event.payload.run.id;
                } else if (
                    event.type === "run.boundary" &&
                    event.payload.agentId === opened.id &&
                    activeRunId === event.payload.finishedRun.id
                ) {
                    activeRunId = event.payload.startedRun.id;
                } else if (
                    event.type === "run.finished" &&
                    event.payload.agentId === opened.id &&
                    activeRunId === event.payload.run.id
                ) {
                    terminalRun = event.payload.run;
                    return true;
                }
                return false;
            },
        });
    } finally {
        process.off("SIGINT", abort);
        controller.abort();
        await events.close();
    }

    const history = await connection.client.getMessages(opened.id, { limit: 50 });
    const response = lastAgentText(history.runs.flatMap((run) => run.messages));
    if (failure !== undefined || terminalRun?.status === "failed") {
        emitFailure(
            options.outputFormat,
            failure ?? "The agent run failed.",
            opened.id,
            terminalRun?.id ?? activeRunId ?? submitted.message.id,
        );
        process.exitCode = 1;
        return;
    }

    const result = {
        agentId: opened.id,
        response,
        runId: terminalRun?.id ?? activeRunId ?? submitted.message.id,
        stopReason: terminalRun?.reason ?? "error",
        type: "result",
    };
    if (options.outputFormat === "text") {
        process.stdout.write(
            response.length === 0 || response.endsWith("\n") ? response : `${response}\n`,
        );
    } else {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if (terminalRun === undefined || terminalRun.status === "aborted") process.exitCode = 1;
}

async function openAgent(
    options: ExecCommandOptions,
    cwd: string,
    client: HappyAgentClient,
): Promise<Agent> {
    if (options.fork) {
        throw new HappyTerminalUserError("The Happy Agent API does not expose agent forking.", {
            hint: "Resume an agent or start a new one.",
        });
    }
    let agentId = options.resumeSessionId;
    if (options.last) {
        const catalog = await loadAgentCatalog(client);
        agentId = catalog.entries
            .filter((entry) => entry.cwd === cwd)
            .sort((left, right) => right.agent.updatedAt - left.agent.updatedAt)[0]?.agent.id;
        if (agentId === undefined) {
            throw new HappyTerminalUserError(
                "Happy Terminal has no saved agents in this directory.",
                {
                    hint: "Pass --resume <agent-id> to name one explicitly.",
                },
            );
        }
    }
    if (agentId !== undefined) return (await client.getAgent(agentId)).agent;
    const workspace = await ensureWorkspaceForCwd(client, cwd);
    return (await client.createAgent({ workspaceId: workspace.id })).agent;
}

function resolveMode(
    options: ExecCommandOptions,
    environment: NodeJS.ProcessEnv,
    defaults: {
        effort?: string;
        modelId: string;
        permissionMode: PermissionMode;
        providerId?: string;
        serviceTier?: "fast";
    },
    config: DaemonConfig,
    previous: MessageMode | null,
): MessageMode {
    const providerId =
        options.providerId ??
        environment.HAPPY_TERMINAL_PROVIDER ??
        previous?.providerId ??
        defaults.providerId ??
        config.defaults.providerId;
    const modelId =
        options.modelId ??
        environment.HAPPY_TERMINAL_MODEL ??
        previous?.modelId ??
        defaults.modelId ??
        config.defaults.modelId;
    const effort =
        options.effort ??
        environment.HAPPY_TERMINAL_EFFORT ??
        previous?.effort ??
        defaults.effort ??
        config.defaults.effort;
    const permissionMode =
        options.permissionMode ??
        (environment.HAPPY_TERMINAL_PERMISSION_MODE === undefined
            ? undefined
            : parsePermissionMode(environment.HAPPY_TERMINAL_PERMISSION_MODE)) ??
        previous?.permissionMode ??
        defaults.permissionMode ??
        config.defaults.permissionMode;
    const providerModel = config.providers[providerId]?.models.find(
        (reference) => reference.id === modelId && reference.enabled,
    );
    if (providerModel === undefined) {
        throw new HappyTerminalUserError(
            `Model '${modelId}' is not enabled on provider '${providerId}'.`,
        );
    }
    const tiers = providerModel.serviceTiers ?? config.models[modelId]?.serviceTiers ?? [];
    return {
        effort,
        modelId,
        permissionMode,
        providerId,
        serviceTier:
            previous?.serviceTier ?? (defaults.serviceTier === "fast" ? (tiers[0] ?? null) : null),
    };
}

function lastAgentText(messages: readonly Message[]): string {
    const message = [...messages].reverse().find((candidate) => candidate.role === "agent");
    if (message === undefined || message.role !== "agent") return "";
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function emitFailure(
    outputFormat: ExecCommandOptions["outputFormat"],
    message: string,
    agentId: string,
    runId: string,
): void {
    if (outputFormat === "text") {
        throw new Error(message);
    }
    process.stdout.write(`${JSON.stringify({ agentId, error: message, runId, type: "error" })}\n`);
}
