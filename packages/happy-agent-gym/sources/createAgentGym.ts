import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { AgentModel, AgentPermissionMode } from "@slopus/happy-agent-base";
import {
    HappyAgentClient,
    type Agent,
    type HappyAgentEvent,
    type MessageHistoryResponse,
    type SendMessageRequest,
    type SendMessageResponse,
} from "@slopus/happy-agent-client";
import { startHappyAgentDaemon, type HappyAgentDaemon } from "@slopus/happy-agent";

import { createGymCompute } from "./createGymCompute.js";
import {
    createGymHome,
    resolveFixturePath,
    type GymHome,
    type GymHomeOptions,
} from "./createGymHome.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { HappyAgentEventStream } from "./HappyAgentEventStream.js";
import type { GymEventStreamOptions } from "./GymEventStream.js";
import { GymHttpClient } from "./GymHttpClient.js";
import {
    createScriptedInference,
    GYM_MODEL_ID,
    GYM_PROVIDER_ID,
    type GymCompactionHandler,
    type GymInference,
    type GymInferenceLog,
} from "./scriptedInference.js";

export interface AgentGymOptions extends GymHomeOptions {
    /** Fixed agent turns, or a handler that answers every request including detached naming. */
    readonly inference?: GymInference;
    /** How a scripted compaction answers. Defaults to a completed, empty compaction. */
    readonly compaction?: GymCompactionHandler;
    /** Replaces the two models a gym serves. */
    readonly models?: readonly AgentModel[];
    /** Test-owned environment values supplied to the daemon's configuration module. */
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    /** The default budget for every `waitFor` in this gym. */
    readonly timeoutMs?: number;
    /** The version the daemon reports. */
    readonly version?: string;
}

/** Everything a request must name, so a test never has to repeat it. */
export interface GymSelection {
    readonly effort: string;
    readonly modelId: string;
    readonly providerId: string;
    readonly serviceTier: null;
}

/** An agent as the daemon reports it. */
export type GymSessionRecord = Agent;

/** The API's grouped transcript shape. */
export type GymAgentHistory = MessageHistoryResponse;

/** One public API event envelope. */
export type GymAgentEvent = HappyAgentEvent;

/** The accepted message and its run. */
export interface GymAcceptance {
    /** The API message ID. */
    readonly id: string;
    /** The run that accepted the message. */
    readonly runId: string;
    /** The agent that owns the message. */
    readonly agentId: string;
    /** The owning agent ID, retained for existing gym scenario ergonomics. */
    readonly sessionId: string;
    /** The public event cursor at send time. */
    readonly cursor: string;
    readonly [key: string]: unknown;
}

export interface GymSendOptions {
    /** The agent to send to. Defaults to the chat the gym opened as it started. */
    readonly sessionId?: string;
    /**
     * Whether to return only after the run this message started has settled. Defaults to true for
     * a send and false for steering, which by definition joins a run that is already going.
     */
    readonly wait?: boolean;
    readonly effort?: string;
    readonly modelId?: string;
    readonly providerId?: string;
    readonly permissionMode?: AgentPermissionMode;
    /** Optional client-chosen message identity. */
    readonly id?: string;
}

export interface GymCreateSessionOptions {
    /** The folder the agent works in. Defaults to the gym workspace. */
    readonly cwd?: string;
    readonly id?: string;
    /** Optional fixed title for the agent. */
    readonly title?: string;
}

/**
 * One complete, isolated Happy agent.
 *
 * The daemon, its socket, both databases, every module, the agent loop, the tools and the
 * permission reviewer are the real product. Only two things are substituted: the model is
 * scripted, and the machine is a just-bash shell over the gym's own workspace folder, so a
 * scenario never starts a process on the computer running the test.
 */
export interface AgentGym {
    /** Happy's private root for this gym. */
    readonly happyHome: string;
    /** The public Happy folder, where the daemon keeps its user-facing configuration. */
    readonly publicHomePath: string;
    /** The agent's working directory, which is also where fixtures were written. */
    readonly workspacePath: string;
    readonly socketPath: string;
    readonly token: string;
    /** The typed public API client over the daemon's real Unix socket. */
    readonly client: HappyAgentClient;
    /**
     * Raw Unix-socket access reserved for auth/header/unknown-route probes.
     *
     * Ordinary JSON and SSE scenarios must use {@link client}; this exists so
     * the black-box suite can prove transport failures without a second API
     * implementation.
     */
    readonly raw: GymHttpClient;
    /** @deprecated Use {@link raw}; retained for existing local gym scenarios only. */
    readonly http: GymHttpClient;
    /** What the scripted model was asked, and what it could not answer. */
    readonly inference: GymInferenceLog;
    readonly daemon: HappyAgentDaemon;
    /**
     * The agent every scenario works in unless it names another.
     *
     * The daemon has no agent of its own, so the gym opens one as it starts. Scenarios that need
     * another agent call `createSession`.
     */
    readonly defaultSessionId: string;
    /** The provider, model, effort and tier every gym request names by default. */
    readonly selection: GymSelection;
    /** Errors the HTTP server reported outside a response. A healthy scenario leaves this empty. */
    readonly errors: readonly unknown[];

    /** Send a user message and, by default, wait for the run it starts to settle. */
    send(text: string, options?: GymSendOptions): Promise<GymAcceptance>;
    /** Queue a message for the current turn's boundary. */
    steer(text: string, options?: GymSendOptions): Promise<GymAcceptance>;
    /** Wait for one run to settle, and answer with the durable event that says how it ended. */
    waitForRun(runId: string, timeoutMs?: number): Promise<GymAgentEvent>;
    /** Cancel the active turn. */
    abort(sessionId?: string): Promise<unknown>;
    /** Compact a conversation. */
    compact(sessionId?: string): Promise<unknown>;
    /** Create another agent. The historic helper name keeps scenarios concise. */
    createSession(options?: GymCreateSessionOptions): Promise<GymSessionRecord>;
    /** Every top-level agent in the gym's root workspace. */
    listSessions(): Promise<readonly GymSessionRecord[]>;
    /** One agent. */
    getSession(sessionId?: string): Promise<GymSessionRecord>;
    /** The agent transcript grouped by run, plus messages waiting to be accepted. */
    history(sessionId?: string): Promise<GymAgentHistory>;
    /** All public events for one agent. */
    sessionEvents(sessionId?: string): Promise<readonly Record<string, unknown>[]>;

    /** Every durable event the installation has recorded, oldest first. */
    events(): Promise<readonly GymAgentEvent[]>;
    /** The first durable event matching `predicate`, waiting for it to arrive. */
    waitForEvent(
        predicate: (event: GymAgentEvent) => boolean,
        description?: string,
        timeoutMs?: number,
    ): Promise<GymAgentEvent>;
    /**
     * Wait for any condition, polling instead of sleeping.
     *
     * `check` returns the value the caller wanted, or `undefined` while it is not there yet.
     */
    waitUntil<Result>(
        check: () => Result | undefined | Promise<Result | undefined>,
        description?: string | (() => string),
        timeoutMs?: number,
    ): Promise<Result>;
    /** Open one Server-Sent Events subscription, such as `/v0/events/stream`. */
    stream(path?: string, options?: GymEventStreamOptions): HappyAgentEventStream;

    /** Read a file from the workspace as text. */
    readFile(path: string): Promise<string>;
    /** Write a file into the workspace. */
    writeFile(path: string, content: string): Promise<void>;
    /** Whether a workspace path exists. */
    exists(path: string): Promise<boolean>;
    /** Every file in the workspace, relative to it and sorted. */
    listFiles(): Promise<readonly string[]>;

    /** Stop the daemon and start it again on the same folder, the way a restart really happens. */
    restart(): Promise<void>;
    /** Stop everything and delete the folder. Always call this, including when a test fails. */
    dispose(): Promise<void>;
}

/** Start one gym. Every call is completely isolated from every other. */
export async function createAgentGym(options: AgentGymOptions = {}): Promise<AgentGym> {
    const home = await createGymHome(options);
    try {
        const gym = new AgentGymInstance(home, options);
        await gym.start();
        return gym;
    } catch (error) {
        await home.remove().catch(() => undefined);
        throw error;
    }
}

class AgentGymInstance implements AgentGym {
    readonly #home: GymHome;
    readonly #options: AgentGymOptions;
    readonly #scripted: ReturnType<typeof createScriptedInference>;
    readonly #errors: unknown[] = [];
    readonly #timeoutMs: number;
    #daemon: HappyAgentDaemon | undefined;
    #client: HappyAgentClient | undefined;
    #http: GymHttpClient | undefined;
    #token = "";
    #defaultSessionId: string | undefined;
    #rootWorkspaceId: string | undefined;
    readonly #workspaceIdsByPath = new Map<string, string>();

    constructor(home: GymHome, options: AgentGymOptions) {
        this.#home = home;
        this.#options = options;
        this.#timeoutMs = options.timeoutMs ?? 10_000;
        this.#scripted = createScriptedInference({
            ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
            ...(options.inference === undefined ? {} : { inference: options.inference }),
            ...(options.models === undefined ? {} : { models: options.models }),
        });
    }

    async start(): Promise<void> {
        const daemon = await startHappyAgentDaemon({
            compute: createGymCompute(),
            environment: {
                ANTHROPIC_API_KEY: undefined,
                ANTHROPIC_AUTH_TOKEN: undefined,
                CLAUDE_CODE_OAUTH_TOKEN: undefined,
                CODEX_HOME: join(this.#home.root, "credentials", "codex"),
                GIT_CEILING_DIRECTORIES: resolve(this.#home.root, "..", ".."),
                GROK_HOME: join(this.#home.root, "credentials", "grok"),
                HAPPY_AGENT_PROJECTS_DIRECTORY: join(this.#home.root, "projects"),
                HAPPY_AGENT_WORKSPACES_DIRECTORY: join(this.#home.root, "workspaces"),
                HAPPY_HOME_DIR: join(this.#home.root, "credentials", "happy"),
                OPENAI_API_KEY: undefined,
                XAI_API_KEY: undefined,
                ...this.#options.environment,
            },
            happyHome: this.#home.happyHome,
            inference: {
                models: this.#scripted.models,
                providers: this.#scripted.providers,
            },
            version: this.#options.version ?? "gym",
        });
        this.#daemon = daemon;
        this.#token = (await readFile(daemon.tokenPath, "utf8")).trim();
        this.#http = new GymHttpClient({
            socketPath: daemon.socketPath,
            timeoutMs: Math.max(this.#timeoutMs, 20_000),
            token: this.#token,
        });
        this.#client = new HappyAgentClient({
            endpoint: "http://happy-agent.gym",
            fetch: createUnixSocketFetch(daemon.socketPath),
            token: this.#token,
        });
        // A project is its root workspace. Register the gym directory once, then put the default
        // agent in that root workspace. A restart keeps both durable resources.
        this.#rootWorkspaceId ??= await this.#registerProject(this.workspacePath);
        // Nothing in the daemon opens an agent by itself, so the gym opens the one every scenario
        // works in before any of them runs. A restart keeps it: the agent is durable, and a
        // scenario that restarts the daemon is asking whether its own conversation survived.
        this.#defaultSessionId ??= (await this.createSession()).id;
    }

    get happyHome(): string {
        return this.#home.happyHome;
    }

    get publicHomePath(): string {
        return this.#home.publicHomePath;
    }

    get workspacePath(): string {
        return this.#home.workspacePath;
    }

    get socketPath(): string {
        return this.#running.socketPath;
    }

    get token(): string {
        return this.#token;
    }

    get http(): GymHttpClient {
        return this.raw;
    }

    get raw(): GymHttpClient {
        if (this.#http === undefined) throw new Error("This gym is not running.");
        return this.#http;
    }

    get client(): HappyAgentClient {
        if (this.#client === undefined) throw new Error("This gym is not running.");
        return this.#client;
    }

    get inference(): GymInferenceLog {
        return this.#scripted.log;
    }

    get daemon(): HappyAgentDaemon {
        return this.#running;
    }

    get defaultSessionId(): string {
        if (this.#defaultSessionId === undefined) throw new Error("This gym is not running.");
        return this.#defaultSessionId;
    }

    get selection(): GymSelection {
        return {
            effort: "medium",
            modelId: this.#scripted.models[0]?.id ?? GYM_MODEL_ID,
            providerId: this.#scripted.models[0]?.providerId ?? GYM_PROVIDER_ID,
            serviceTier: null,
        };
    }

    get errors(): readonly unknown[] {
        return this.#errors;
    }

    async send(text: string, options: GymSendOptions = {}): Promise<GymAcceptance> {
        const agentId = this.#sessionId(options.sessionId);
        const response = await this.client.sendMessage(
            agentId,
            this.#messageBody(text, options, "queue"),
        );
        const acceptance = await this.#acceptance(agentId, response);
        if (options.wait ?? true) await this.waitForRun(acceptance.runId);
        return acceptance;
    }

    async steer(text: string, options: GymSendOptions = {}): Promise<GymAcceptance> {
        const agentId = this.#sessionId(options.sessionId);
        const response = await this.client.sendMessage(
            agentId,
            this.#messageBody(text, options, "steer"),
        );
        const acceptance = await this.#acceptance(agentId, response);
        if (options.wait === true) await this.waitForRun(acceptance.runId);
        return acceptance;
    }

    async waitForRun(runId: string, timeoutMs = this.#timeoutMs): Promise<GymAgentEvent> {
        return await this.waitForEvent(
            (event) =>
                (event.type === "run.finished" || event.type === "run.boundary") &&
                finishedRunIdOf(event) === runId,
            `run ${runId} to settle`,
            timeoutMs,
        );
    }

    async abort(sessionId?: string): Promise<unknown> {
        return await this.client.abortAgent(this.#sessionId(sessionId));
    }

    async compact(sessionId?: string): Promise<unknown> {
        return await this.client.compactAgent(this.#sessionId(sessionId));
    }

    async createSession(options: GymCreateSessionOptions = {}): Promise<GymSessionRecord> {
        const workspaceId = await this.#workspaceForPath(options.cwd ?? this.workspacePath);
        return (
            await this.client.createAgent({
                workspaceId,
                ...(options.id === undefined ? {} : { id: options.id }),
                ...(options.title === undefined ? {} : { title: options.title }),
            })
        ).agent;
    }

    async listSessions(): Promise<readonly GymSessionRecord[]> {
        const body = await this.client.listProjects();
        const project = body.projects.find(
            (candidate) => candidate.id === this.#rootWorkspaceIdOrThrow(),
        );
        return project?.agents ?? [];
    }

    async getSession(sessionId?: string): Promise<GymSessionRecord> {
        return (await this.client.getAgent(this.#sessionId(sessionId))).agent;
    }

    async history(sessionId?: string): Promise<GymAgentHistory> {
        return await this.client.getMessages(this.#sessionId(sessionId));
    }

    async sessionEvents(sessionId?: string): Promise<readonly Record<string, unknown>[]> {
        const agentId = this.#sessionId(sessionId);
        return (await this.events())
            .filter((event) => agentIdOfEvent(event) === agentId)
            .map((event): Record<string, unknown> => ({ ...event }));
    }

    async events(): Promise<readonly GymAgentEvent[]> {
        return (await this.client.getEvents({ limit: 10_000 })).events;
    }

    async waitForEvent(
        predicate: (event: GymAgentEvent) => boolean,
        description = "a matching event",
        timeoutMs = this.#timeoutMs,
    ): Promise<GymAgentEvent> {
        let seen: readonly GymAgentEvent[] = [];
        return await this.waitUntil(
            async () => {
                seen = await this.events();
                return seen.find(predicate);
            },
            () => `${description}. Recorded: ${seen.map((event) => event.type).join(", ")}`,
            timeoutMs,
        );
    }

    async waitUntil<Result>(
        check: () => Result | undefined | Promise<Result | undefined>,
        description: string | (() => string) = "a condition",
        timeoutMs = this.#timeoutMs,
    ): Promise<Result> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const result = await check();
            if (result !== undefined) return result;
            if (Date.now() >= deadline) {
                const text = typeof description === "function" ? description() : description;
                throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${text}`);
            }
            await sleep(20);
        }
    }

    stream(path = "/v0/events/stream", options: GymEventStreamOptions = {}): HappyAgentEventStream {
        if (path !== "/v0/events/stream") {
            throw new Error("The typed event stream only supports /v0/events/stream.");
        }
        return new HappyAgentEventStream(this.client, {
            timeoutMs: this.#timeoutMs,
            ...options,
        });
    }

    async readFile(path: string): Promise<string> {
        return await readFile(resolveFixturePath(this.workspacePath, path), "utf8");
    }

    async writeFile(path: string, content: string): Promise<void> {
        await writeFile(resolveFixturePath(this.workspacePath, path), content, "utf8");
    }

    async exists(path: string): Promise<boolean> {
        try {
            await readFile(resolveFixturePath(this.workspacePath, path));
            return true;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "EISDIR") return true;
            return false;
        }
    }

    async listFiles(): Promise<readonly string[]> {
        const entries = await readdir(this.workspacePath, {
            recursive: true,
            withFileTypes: true,
        });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => relative(this.workspacePath, `${entry.parentPath}/${entry.name}`))
            .sort();
    }

    async restart(): Promise<void> {
        await this.#running.close();
        this.#daemon = undefined;
        this.#client = undefined;
        this.#http = undefined;
        await this.start();
    }

    async dispose(): Promise<void> {
        await this.#daemon?.close().catch(() => undefined);
        this.#daemon = undefined;
        this.#client = undefined;
        this.#http = undefined;
        await this.#home.remove().catch(() => undefined);
    }

    get #running(): HappyAgentDaemon {
        if (this.#daemon === undefined) throw new Error("This gym is not running.");
        return this.#daemon;
    }

    #sessionId(sessionId: string | undefined): string {
        return sessionId ?? this.defaultSessionId;
    }

    #messageBody(
        text: string,
        options: GymSendOptions,
        delivery: "queue" | "steer",
    ): SendMessageRequest {
        const selection = this.selection;
        return {
            delivery,
            mode: {
                effort: options.effort ?? selection.effort,
                modelId: options.modelId ?? selection.modelId,
                permissionMode: options.permissionMode ?? "auto",
                providerId: options.providerId ?? selection.providerId,
                serviceTier: null,
            },
            text,
            ...(options.id === undefined ? {} : { id: options.id }),
        };
    }

    async #acceptance(agentId: string, response: SendMessageResponse): Promise<GymAcceptance> {
        return {
            agentId,
            cursor: response.cursor,
            id: response.message.id,
            runId: await this.#acceptedRunId(agentId, response.message),
            sessionId: agentId,
        };
    }

    async #acceptedRunId(
        agentId: string,
        message: SendMessageResponse["message"],
    ): Promise<string> {
        if (message.runId !== null && message.runId !== undefined) return message.runId;
        const event = await this.waitForEvent(
            (candidate) =>
                agentIdOfEvent(candidate) === agentId &&
                acceptedMessageIdsOf(candidate).includes(message.id),
            `message ${message.id} to be accepted`,
        );
        const runId = startedRunIdOf(event);
        if (runId === undefined) {
            throw new Error(
                `The Happy agent accepted message ${message.id} without starting a run.`,
            );
        }
        return runId;
    }

    async #workspaceForPath(path: string): Promise<string> {
        const known = this.#workspaceIdsByPath.get(path);
        if (known !== undefined) return known;
        return await this.#registerProject(path);
    }

    async #registerProject(path: string): Promise<string> {
        const body = await this.client.registerProject({ path });
        this.#workspaceIdsByPath.set(path, body.project.id);
        return body.project.id;
    }

    #rootWorkspaceIdOrThrow(): string {
        if (this.#rootWorkspaceId === undefined) {
            throw new Error("This gym has not registered its root workspace.");
        }
        return this.#rootWorkspaceId;
    }
}

/** The run an event belongs to, for the events that name one. */
export function runIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const direct = (payload as { readonly runId?: unknown }).runId;
    if (typeof direct === "string") return direct;
    return startedRunIdOf(event) ?? finishedRunIdOf(event);
}

/** The agent an event belongs to, when its payload names one directly. */
export function agentIdOfEvent(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const agentId = (payload as { readonly agentId?: unknown }).agentId;
    return typeof agentId === "string" ? agentId : undefined;
}

function acceptedMessageIdsOf(event: GymAgentEvent): readonly string[] {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return [];
    const values = (payload as { readonly acceptedMessageIds?: unknown }).acceptedMessageIds;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return [];
    return values;
}

function startedRunIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const run =
        event.type === "run.boundary"
            ? (payload as { readonly startedRun?: unknown }).startedRun
            : (payload as { readonly run?: unknown }).run;
    if (run === null || typeof run !== "object") return undefined;
    const id = (run as { readonly id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
}

function finishedRunIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const run =
        event.type === "run.boundary"
            ? (payload as { readonly finishedRun?: unknown }).finishedRun
            : (payload as { readonly run?: unknown }).run;
    if (run === null || typeof run !== "object") return undefined;
    const id = (run as { readonly id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
}

/** Delete a path inside a gym workspace. Exported for scenarios that arrange missing files. */
export async function removeWorkspacePath(gym: AgentGym, path: string): Promise<void> {
    await rm(resolveFixturePath(gym.workspacePath, path), { force: true, recursive: true });
}
