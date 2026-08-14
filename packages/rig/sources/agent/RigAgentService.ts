import { createId } from "@paralleldrive/cuid2";
import {
    AgentKV,
    AgentStorage,
    AgentSystemLocal,
    type Agent,
    type AgentModel,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { asyncLock, type Context } from "@steve.kite/stdlib";

import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import {
    createEventIdFactory,
    type AbortRunOptions,
    type AbortRunResponse,
    type ProtocolSession,
    type SessionEvent,
    type SteerMessageRequest,
    type SteerMessageResponse,
    type SubmitMessageRequest,
    type SubmitMessageResponse,
} from "../protocol/index.js";
import type { ConfigProviders } from "../config/types.js";
import type { ModelCatalog } from "../protocol/index.js";
import { createAgentRuntimeConfig } from "./createAgentRuntimeConfig.js";
import { RigProtocolFeature, type RigAgentProtocolSession } from "./RigProtocolFeature.js";
import { SqliteAgentPersistence } from "./persistence/SqliteAgentPersistence.js";

const SYSTEM_AGENT_ID = "$system";

export class RigAgentService {
    readonly #bridge: RigProtocolFeature;
    readonly #links: AgentKV;
    readonly #linkLock = asyncLock({ reentry: "block" });
    readonly #models: readonly AgentModel[];
    readonly #system: AgentSystemLocal;
    readonly #nextEventId = createEventIdFactory();

    static async open(
        ctx: Context,
        options: {
            database: SessionDatabase;
            env?: NodeJS.ProcessEnv;
            modelCatalog: ModelCatalog;
            providers: ConfigProviders;
            resolveInferenceMaxRetries?: () => number;
        },
    ): Promise<RigAgentService> {
        let lockHandedToSystem = false;
        try {
            const systemPersistence = new SqliteAgentPersistence(options.database, SYSTEM_AGENT_ID);
            const storage = new AgentStorage({
                acquireLock: async () => {
                    if (lockHandedToSystem) {
                        throw new Error("The agent database lock is already owned.");
                    }
                    lockHandedToSystem = true;
                    return {
                        release: async () => {
                            lockHandedToSystem = false;
                        },
                    };
                },
                kv: new AgentKV(systemPersistence, "system."),
                persistence: (agentId) => new SqliteAgentPersistence(options.database, agentId),
            });
            const runtime = createAgentRuntimeConfig({
                catalog: options.modelCatalog,
                env: options.env ?? process.env,
                providers: options.providers,
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
            });
            const bridge = new RigProtocolFeature();
            const system = await AgentSystemLocal.create(ctx, storage, {
                features: [bridge],
                models: runtime.models,
                provider: runtime.defaultProvider,
                providers: runtime.providers,
            });
            return new RigAgentService(
                bridge,
                new AgentKV(systemPersistence, "protocol-links."),
                runtime.models,
                system,
            );
        } catch (error) {
            throw error;
        }
    }

    private constructor(
        bridge: RigProtocolFeature,
        links: AgentKV,
        models: readonly AgentModel[],
        system: AgentSystemLocal,
    ) {
        this.#bridge = bridge;
        this.#links = links;
        this.#models = models;
        this.#system = system;
    }

    async submit(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: SubmitMessageRequest,
    ): Promise<SubmitMessageResponse> {
        const agent = await this.#agent(ctx, session.id);
        const snapshot = session.snapshot();
        const runId = createId();
        const messageId = request.clientSubmissionId ?? createId();
        const options = messageOptions(this.#models, snapshot, request);
        const message = {
            blocks: [{ type: "text" as const, text: request.displayText ?? request.text }],
            id: messageId,
            identity: request.identity ?? null,
            role: "user" as const,
        };
        const protocolRun = this.#bridge.register(agent.id, {
            delivery: "run",
            displayText: request.displayText ?? request.text,
            messageId,
            message,
            modelId: options.model,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            providerId: options.provider,
            runId,
            session,
            snapshot,
        });
        try {
            await this.#system.send(
                ctx,
                agent.id,
                { role: "user", content: [{ type: "text", text: request.text }] },
                { ...options, await: true },
            );
        } catch (error) {
            protocolRun.cancel();
            throw error;
        }
        const submitted = await protocolRun.projected();
        return {
            eventId: submitted.id,
            runId,
            sessionId: session.id,
        };
    }

    async steer(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: SteerMessageRequest,
    ): Promise<SteerMessageResponse> {
        const agent = await this.#agent(ctx, session.id);
        const snapshot = session.snapshot();
        const runId = request.expectedRunId ?? createId();
        const delivery = request.expectedRunId === undefined ? "run" : "steer";
        const messageId = request.clientSubmissionId ?? createId();
        const options = messageOptions(this.#models, snapshot, request);
        const message = {
            blocks: [{ type: "text" as const, text: request.displayText ?? request.text }],
            id: messageId,
            identity: request.identity ?? null,
            role: "user" as const,
        };
        const protocolRun = this.#bridge.register(agent.id, {
            delivery,
            displayText: request.displayText ?? request.text,
            messageId,
            message,
            modelId: options.model,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            providerId: options.provider,
            runId,
            session,
            snapshot,
        });
        try {
            await this.#system.steer(
                ctx,
                agent.id,
                { role: "user", content: [{ type: "text", text: request.text }] },
                { ...options, await: true },
            );
        } catch (error) {
            protocolRun.cancel();
            throw error;
        }
        const submitted = await protocolRun.projected();
        return {
            delivery,
            eventId: submitted.id,
            runId,
            sessionId: session.id,
        };
    }

    async abort(
        ctx: Context,
        session: RigAgentProtocolSession,
        options: AbortRunOptions = {},
    ): Promise<AbortRunResponse> {
        const linked = await this.#links.read(ctx, session.id);
        if (typeof linked !== "string") return { aborted: false };
        if (!this.#bridge.hasPending(linked, options.expectedRunId)) {
            return { aborted: false };
        }
        await this.#system.abort(ctx, linked);
        const event = await session.events.append(ctx, {
            createdAt: Date.now(),
            data: {
                ...(options.continuePendingSteering === true
                    ? { continuePendingSteering: true as const }
                    : {}),
                ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
                ...(options.expectedRunId === undefined ? {} : { runId: options.expectedRunId }),
            },
            id: this.#nextEventId(),
            sessionId: session.id,
            type: "abort_requested",
        });
        return {
            aborted: true,
            ...(options.continuePendingSteering === true ? { continued: true } : {}),
            eventId: event.id,
        };
    }

    async close(ctx: Context): Promise<void> {
        await this.#system.close(ctx);
    }

    async #agent(ctx: Context, sessionId: string): Promise<Agent> {
        return await this.#linkLock.runInLock(ctx, async (lockCtx) => {
            const linked = await this.#links.read(lockCtx, sessionId);
            if (typeof linked === "string") return await this.#system.resolve(lockCtx, linked);
            const agent = await this.#system.create(lockCtx, {});
            await this.#links.write(lockCtx, sessionId, agent.id);
            return agent;
        });
    }
}

function messageOptions(
    models: readonly AgentModel[],
    session: ProtocolSession,
    request: SubmitMessageRequest,
) {
    const model = request.modelId ?? session.modelId;
    const provider =
        request.providerId ??
        (models.some(
            (candidate) => candidate.providerId === session.providerId && candidate.id === model,
        )
            ? session.providerId
            : models.find((candidate) => candidate.id === model)?.providerId);
    const selected = models.find(
        (candidate) => candidate.providerId === provider && candidate.id === model,
    );
    if (provider === undefined || selected === undefined) {
        throw new Error(`Model '${model}' is not available from the selected provider.`);
    }
    const effort = toAgentEffort(request.effort ?? session.effort);
    if (effort !== undefined && !selected.effortLevels.includes(effort)) {
        throw new Error(`Model '${model}' does not support the '${effort}' reasoning effort.`);
    }
    const serviceTier =
        request.serviceTier === null ? undefined : (request.serviceTier ?? session.serviceTier);
    return {
        model,
        permissionMode: session.permissionMode as AgentPermissionMode,
        provider,
        ...(effort === undefined ? {} : { effort }),
        ...(serviceTier === "fast" ? { serviceTier: "priority" as const } : {}),
    };
}

function toAgentEffort(value: string | undefined): SessionReasoningEffort | undefined {
    if (value === "ultra") return "max";
    if (
        value === "off" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max"
    ) {
        return value;
    }
    return undefined;
}
