import { createId } from "@paralleldrive/cuid2";
import type { AgentModule } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProviderScanModule } from "../providerScan/index.js";
import { checkProviderCliSignIn } from "./impl/checkProviderCliSignIn.js";
import { createProviderCliVersion } from "./impl/createProviderCliVersion.js";
import { discoverProviderCli } from "./impl/discoverProviderCli.js";
import { installerProcess } from "./impl/installerProcess.js";
import {
    PROVIDER_CLI_DEFINITIONS,
    type ProviderCliDefinition,
    type ProviderCliMachine,
} from "./impl/providerCliCatalog.js";
import {
    appendOutputLine,
    startProviderCliProcess,
    type ProviderCliProcess,
} from "./impl/startProviderCliProcess.js";
import {
    PROVIDER_CLI_IDS,
    ProviderCliRequestError,
    providerCliIdSchema,
    providerCliSignInMethodSchema,
    type ProviderCli,
    type ProviderCliId,
    type ProviderCliInstallation,
    type ProviderCliOperation,
    type ProviderCliOperationError,
    type ProviderCliSignIn,
    type ProviderCliSignInMethod,
} from "./ProviderCli.js";

const INSTALL_FUNCTION = "provider-cli-install";
const SIGN_IN_FUNCTION = "provider-cli-sign-in";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1_000;
const OUTPUT_COALESCE_MS = 250;

const operationArgumentsSchema = Type.Object(
    {
        cliId: providerCliIdSchema,
        operationId: Type.String({ minLength: 1 }),
        method: Type.Optional(providerCliSignInMethodSchema),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);
type OperationArguments = typeof operationArgumentsSchema.static;

type Listener = (providerCli: ProviderCli, mutationId: string | undefined) => void;

interface Entry {
    installation: ProviderCliInstallation;
    signIn: Pick<ProviderCliSignIn, "status" | "account">;
    operation: ProviderCliOperation | null;
    /** The request that started or last changed the operation, echoed by its events. */
    mutationId: string | undefined;
    version: string;
    updatedAt: number;
    discovered: boolean;
}

/**
 * Finds, installs, and signs in the assistants' own command-line programs on the daemon's
 * machine, so a person never needs a terminal to make a provider usable.
 *
 * Installs and sign-ins are Durable Functions: each runs on the durable context, outliving the
 * request that started it, and at most one runs per assistant. An install interrupted by a
 * restart runs again, because vendor installers are safe to repeat; a sign-in cannot survive the
 * program that was waiting for the browser, so it ends as interrupted.
 */
export class ProviderClisModule implements AgentModule {
    readonly name = "provider-clis";

    readonly #config: ConfigModule;
    readonly #providerScan: ProviderScanModule;
    readonly #durable: DurableFunctionsModule;
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #entries = new Map<ProviderCliId, Entry>();
    readonly #processes = new Map<ProviderCliId, ProviderCliProcess>();
    readonly #refreshes = new Map<ProviderCliId, Promise<void>>();
    readonly #pendingEmits = new Map<ProviderCliId, NodeJS.Timeout>();
    readonly #listeners = new Set<Listener>();

    constructor(
        config: ConfigModule,
        providerScan: ProviderScanModule,
        durable: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#providerScan = providerScan;
        this.#durable = durable;
        const now = Date.now();
        for (const id of PROVIDER_CLI_IDS) {
            this.#entries.set(id, {
                installation: {
                    status: "missing",
                    path: null,
                    version: null,
                    source: null,
                    desktopApp: null,
                },
                signIn: { status: "unknown", account: null },
                operation: null,
                mutationId: undefined,
                version: createProviderCliVersion(now),
                updatedAt: now,
                discovered: false,
            });
        }
        durable.register({
            name: INSTALL_FUNCTION,
            argumentsSchema: operationArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#install(ctx, call.arguments);
                return null;
            },
        });
        durable.register({
            name: SIGN_IN_FUNCTION,
            argumentsSchema: operationArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                // A rerun after a restart finds the first run's marker: the program that was
                // waiting for the browser died with the daemon, so the attempt is over.
                const attempt = createId();
                const stored = await call.kv.getOrCreate(ctx, "attempt", () => attempt);
                if (stored !== attempt) {
                    this.#adopt(call.arguments, "sign_in");
                    this.#finish(ctx, call.arguments.cliId, call.arguments.operationId, "failed", {
                        code: "interrupted",
                        message: "Signing in stopped because Happy restarted. Start it again.",
                    });
                    return null;
                }
                await this.#signIn(ctx, call.arguments);
                return null;
            },
        });
    }

    /** Hear every change of a provider CLI object, after it has happened. */
    onUpdated(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Every assistant, in display order, after refreshing those not busy with an operation. */
    async list(ctx: Context): Promise<readonly ProviderCli[]> {
        await Promise.all(PROVIDER_CLI_IDS.map(async (id) => await this.#refresh(ctx, id)));
        return PROVIDER_CLI_IDS.map((id) => this.#project(id));
    }

    async get(ctx: Context, id: ProviderCliId): Promise<ProviderCli> {
        await this.#refresh(ctx, id);
        return this.#project(id);
    }

    /** Start, or join, installing the assistant with its vendor's official installer. */
    async install(ctx: Context, id: ProviderCliId, mutationId?: string): Promise<ProviderCli> {
        await this.#refresh(ctx, id);
        return await this.#lock.runInLock(ctx, async () => {
            const entry = this.#entry(id);
            const active = activeOperation(entry);
            if (active?.kind === "install") return this.#project(id);
            if (active !== undefined) {
                throw this.#refusal("busy", id, "Wait until signing in finishes, or cancel it.");
            }
            if (entry.installation.status === "installed") {
                throw this.#refusal(
                    "already_installed",
                    id,
                    `${definition(id).name} is already installed.`,
                );
            }
            if (definition(id).installer(process.platform) === null) {
                throw this.#refusal(
                    "no_installer",
                    id,
                    `${definition(id).vendor} offers no installer for this computer.`,
                );
            }
            return await this.#start(ctx, id, "install", INSTALL_FUNCTION, undefined, mutationId);
        });
    }

    /** Start, or join, the vendor's own sign-in with the installed program. */
    async signIn(
        ctx: Context,
        id: ProviderCliId,
        method: ProviderCliSignInMethod | undefined,
        mutationId?: string,
    ): Promise<ProviderCli> {
        await this.#refresh(ctx, id);
        return await this.#lock.runInLock(ctx, async () => {
            const entry = this.#entry(id);
            const active = activeOperation(entry);
            if (active?.kind === "sign_in") return this.#project(id);
            if (active !== undefined) {
                throw this.#refusal("busy", id, "Wait until installing finishes, or cancel it.");
            }
            if (entry.installation.status !== "installed") {
                throw this.#refusal(
                    "not_installed",
                    id,
                    `${definition(id).name} isn't installed yet.`,
                );
            }
            const chosen = method ?? definition(id).methods[0];
            if (chosen === undefined || !definition(id).methods.includes(chosen)) {
                throw this.#refusal(
                    "invalid_request",
                    id,
                    `${definition(id).name} can't sign in that way.`,
                );
            }
            return await this.#start(ctx, id, "sign_in", SIGN_IN_FUNCTION, chosen, mutationId);
        });
    }

    /** Hand the code a vendor's page showed to the sign-in waiting for it. */
    async submitCode(
        ctx: Context,
        id: ProviderCliId,
        code: string,
        mutationId?: string,
    ): Promise<ProviderCli> {
        return await this.#lock.runInLock(ctx, async () => {
            const entry = this.#entry(id);
            const process = this.#processes.get(id);
            if (
                entry.operation?.status !== "waiting" ||
                entry.operation.authorization?.acceptsCode !== true ||
                process === undefined
            ) {
                throw this.#refusal("conflict", id, "No sign-in is waiting for a code.");
            }
            process.write(`${code}\n`);
            entry.mutationId = mutationId ?? entry.mutationId;
            this.#change(ctx, id, {
                message: "Checking the code…",
                authorization: null,
                status: "running",
            });
            return this.#project(id);
        });
    }

    /** Stop the running install or sign-in, if any. */
    async cancel(ctx: Context, id: ProviderCliId, mutationId?: string): Promise<ProviderCli> {
        return await this.#lock.runInLock(ctx, async () => {
            const operation = activeOperation(this.#entry(id));
            if (operation === undefined) return this.#project(id);
            this.#entry(id).mutationId = mutationId ?? this.#entry(id).mutationId;
            await this.#durable.cancel(ctx, durableOperationId(id));
            this.#processes.get(id)?.kill();
            this.#finish(ctx, id, operation.id, "cancelled", null);
            return this.#project(id);
        });
    }

    async #start(
        ctx: Context,
        id: ProviderCliId,
        kind: ProviderCliOperation["kind"],
        functionName: string,
        method: ProviderCliSignInMethod | undefined,
        mutationId: string | undefined,
    ): Promise<ProviderCli> {
        const operationId = createId();
        const result = await this.#durable.invoke(ctx, {
            function: functionName,
            operationId: durableOperationId(id),
            lockKeys: [durableOperationId(id)],
            arguments: {
                cliId: id,
                operationId,
                ...(method === undefined ? {} : { method }),
                ...(mutationId === undefined ? {} : { mutationId }),
            },
        });
        // A call still pending from before a restart owns this assistant; it reports itself.
        if (result.status === "duplicate") return this.#project(id);
        this.#adopt(
            { cliId: id, operationId, ...(mutationId === undefined ? {} : { mutationId }) },
            kind,
        );
        return this.#project(id);
    }

    /** Make the operation a durable call is running the current one, as after a restart. */
    #adopt(args: OperationArguments, kind: ProviderCliOperation["kind"]): void {
        const entry = this.#entry(args.cliId);
        if (entry.operation?.id === args.operationId) return;
        entry.mutationId = args.mutationId;
        entry.operation = {
            id: args.operationId,
            kind,
            status: "running",
            message:
                kind === "install"
                    ? `Getting ready to install ${definition(args.cliId).name}…`
                    : `Starting to sign in to ${definition(args.cliId).name}…`,
            authorization: null,
            output: [],
            error: null,
            startedAt: Date.now(),
            finishedAt: null,
        };
        this.#touch(args.cliId);
        this.#emitNow(args.cliId);
    }

    async #install(ctx: Context, args: OperationArguments): Promise<void> {
        const id = args.cliId;
        const cli = definition(id);
        this.#adopt(args, "install");
        const installer = cli.installer(process.platform);
        if (installer === null) {
            this.#finish(ctx, id, args.operationId, "failed", {
                code: "install_failed",
                message: `${cli.vendor} offers no installer for this computer.`,
            });
            return;
        }
        this.#change(ctx, id, {
            message: `Downloading ${cli.name} from ${installer.sourceHost}…`,
        });
        const launch = installerProcess(process.platform, installer.command);
        const code = await this.#runProcess(
            ctx,
            id,
            args.operationId,
            launch.command,
            launch.args,
            INSTALL_TIMEOUT_MS,
        );
        if (!this.#isCurrent(id, args.operationId)) return;
        if (code === "timeout" || code === null || code !== 0) {
            this.#finish(ctx, id, args.operationId, "failed", {
                code: "install_failed",
                message:
                    code === "timeout"
                        ? `Installing ${cli.name} took too long and was stopped.`
                        : `The ${cli.vendor} installer stopped with an error.`,
            });
            return;
        }
        this.#change(ctx, id, { message: `Checking that ${cli.name} works…` });
        await this.#discover(id);
        const entry = this.#entry(id);
        if (entry.installation.status !== "installed" || entry.installation.version === null) {
            this.#finish(ctx, id, args.operationId, "failed", {
                code: "not_found",
                message: `The installer finished, but ${cli.name} can't be found or started.`,
            });
            return;
        }
        await this.#scanProviders(ctx);
        this.#finish(ctx, id, args.operationId, "succeeded", null);
    }

    async #signIn(ctx: Context, args: OperationArguments): Promise<void> {
        const id = args.cliId;
        const cli = definition(id);
        this.#adopt(args, "sign_in");
        const executable = this.#entry(id).installation.path;
        const method = args.method ?? cli.methods[0];
        const flow = method === undefined ? undefined : cli.signIn[method];
        if (executable === null || method === undefined || flow === undefined) {
            this.#finish(ctx, id, args.operationId, "failed", {
                code: "unavailable",
                message: `${cli.name} isn't installed, so it can't sign in.`,
            });
            return;
        }
        const startedAt = this.#entry(id).operation?.startedAt ?? Date.now();
        const timeoutMs = Math.min(
            SIGN_IN_TIMEOUT_MS,
            (flow.waitsMs ?? SIGN_IN_TIMEOUT_MS) + 5_000,
        );
        const watchForPage = (text: string) => {
            const entry = this.#entry(id);
            if (entry.operation?.id !== args.operationId || entry.operation.status !== "running")
                return;
            if (entry.operation.authorization !== null) return;
            const url = flow.url.exec(text)?.[1];
            if (url === undefined) return;
            const userCode = flow.userCode?.exec(text)?.[1] ?? null;
            if (flow.userCode !== undefined && userCode === null) return;
            this.#change(ctx, id, {
                status: "waiting",
                message:
                    method === "device"
                        ? `Open the page and confirm the code to sign in to ${cli.name}.`
                        : flow.openedByProgram
                          ? `Finish signing in to ${cli.name} in your browser.`
                          : `Open the page to sign in to ${cli.name}.`,
                authorization: {
                    method,
                    url,
                    userCode,
                    openedByProgram: flow.openedByProgram,
                    acceptsCode: flow.acceptsCode,
                    expiresAt: startedAt + timeoutMs,
                },
            });
        };
        const code = await this.#runProcess(
            ctx,
            id,
            args.operationId,
            executable,
            flow.args,
            timeoutMs,
            watchForPage,
        );
        if (!this.#isCurrent(id, args.operationId)) return;
        this.#change(ctx, id, {
            status: "running",
            authorization: null,
            message: "Checking the sign-in…",
        });
        await this.#checkSignIn(id);
        if (this.#entry(id).signIn.status === "signed_in") {
            await this.#scanProviders(ctx);
            this.#finish(ctx, id, args.operationId, "succeeded", null);
            return;
        }
        this.#finish(ctx, id, args.operationId, "failed", {
            code: code === "timeout" ? "expired" : code === null ? "unavailable" : "sign_in_failed",
            message:
                code === "timeout"
                    ? `Signing in to ${cli.name} wasn't finished in time. Start it again.`
                    : code === null
                      ? `${cli.name} couldn't be started to sign in.`
                      : `${cli.name} didn't finish signing in.`,
        });
    }

    /**
     * Run one vendor program until it exits, the operation is cancelled, or time runs out. Its
     * lifetime belongs to the durable call's context, never to the request that started it.
     */
    async #runProcess(
        ctx: Context,
        id: ProviderCliId,
        operationId: string,
        command: string,
        args: readonly string[],
        timeoutMs: number,
        onText?: (text: string) => void,
    ): Promise<number | null | "timeout"> {
        const child = startProviderCliProcess(command, args, this.#machine().env, (line) => {
            const entry = this.#entry(id);
            if (entry.operation?.id !== operationId) return;
            entry.operation = {
                ...entry.operation,
                output: appendOutputLine(entry.operation.output, line),
            };
            this.#touch(id);
            onText?.(child.text());
            this.#emitSoon(id);
        });
        this.#processes.set(id, child);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        timer.unref();
        const abort = () => child.kill();
        ctx.lifetime?.addEventListener("abort", abort, { once: true });
        try {
            const code = await child.exited;
            return timedOut ? "timeout" : code;
        } finally {
            clearTimeout(timer);
            ctx.lifetime?.removeEventListener("abort", abort);
            if (this.#processes.get(id) === child) this.#processes.delete(id);
        }
    }

    async #scanProviders(ctx: Context): Promise<void> {
        try {
            await this.#providerScan.scan(ctx);
        } catch (error: unknown) {
            ctx.log.warn("Provider scan after a provider CLI change failed.", {}, error);
        }
    }

    async #refresh(ctx: Context, id: ProviderCliId): Promise<void> {
        if (activeOperation(this.#entry(id)) !== undefined) return;
        const running = this.#refreshes.get(id);
        if (running !== undefined) return await running;
        const refresh = (async () => {
            const before = JSON.stringify([this.#entry(id).installation, this.#entry(id).signIn]);
            await this.#discover(id);
            await this.#checkSignIn(id);
            const entry = this.#entry(id);
            const after = JSON.stringify([entry.installation, entry.signIn]);
            const first = !entry.discovered;
            entry.discovered = true;
            if (before !== after || first) {
                this.#touch(id);
                if (before !== after) this.#emitNow(id);
            }
        })().finally(() => this.#refreshes.delete(id));
        this.#refreshes.set(id, refresh);
        await refresh;
    }

    async #discover(id: ProviderCliId): Promise<void> {
        this.#entry(id).installation = await discoverProviderCli(definition(id), this.#machine());
    }

    async #checkSignIn(id: ProviderCliId): Promise<void> {
        const entry = this.#entry(id);
        entry.signIn =
            entry.installation.status === "installed" || id === "grok"
                ? await checkProviderCliSignIn(id, entry.installation.path, this.#machine())
                : { status: "unknown", account: null };
        if (entry.installation.status !== "installed" && entry.signIn.status !== "signed_in") {
            entry.signIn = { status: "unknown", account: null };
        }
    }

    #machine(): ProviderCliMachine {
        return {
            platform: process.platform,
            env: this.#config.processEnvironment,
            applications: this.#config.applicationsDirectories,
            programDirectories: this.#config.programDirectories,
        };
    }

    #change(
        ctx: Context,
        id: ProviderCliId,
        changes: Partial<Pick<ProviderCliOperation, "status" | "message" | "authorization">>,
    ): void {
        const entry = this.#entry(id);
        if (entry.operation === null) return;
        entry.operation = { ...entry.operation, ...changes };
        this.#touch(id);
        this.#emitNow(id);
    }

    /** Settle the operation once; a later settlement of the same operation changes nothing. */
    #finish(
        ctx: Context,
        id: ProviderCliId,
        operationId: string,
        status: "succeeded" | "failed" | "cancelled",
        error: ProviderCliOperationError | null,
    ): void {
        const entry = this.#entry(id);
        const operation = entry.operation;
        if (operation?.id !== operationId || activeOperation(entry) === undefined) return;
        const name = definition(id).name;
        const message =
            error?.message ??
            (status === "cancelled"
                ? operation.kind === "install"
                    ? `Installing ${name} was cancelled.`
                    : `Signing in to ${name} was cancelled.`
                : operation.kind === "install"
                  ? `${name} is installed.`
                  : signedInMessage(name, entry.signIn.account));
        entry.operation = {
            ...operation,
            status,
            message,
            authorization: null,
            error,
            finishedAt: Date.now(),
        };
        this.#touch(id);
        this.#emitNow(id);
    }

    #isCurrent(id: ProviderCliId, operationId: string): boolean {
        const entry = this.#entry(id);
        return entry.operation?.id === operationId && activeOperation(entry) !== undefined;
    }

    #touch(id: ProviderCliId): void {
        const entry = this.#entry(id);
        const now = Date.now();
        entry.version = createProviderCliVersion(now);
        entry.updatedAt = now;
    }

    /** Output arrives line by line; coalesce it to a few events a second. */
    #emitSoon(id: ProviderCliId): void {
        if (this.#pendingEmits.has(id)) return;
        const timer = setTimeout(() => {
            this.#pendingEmits.delete(id);
            this.#emit(id);
        }, OUTPUT_COALESCE_MS);
        timer.unref();
        this.#pendingEmits.set(id, timer);
    }

    #emitNow(id: ProviderCliId): void {
        const pending = this.#pendingEmits.get(id);
        if (pending !== undefined) {
            clearTimeout(pending);
            this.#pendingEmits.delete(id);
        }
        this.#emit(id);
    }

    #emit(id: ProviderCliId): void {
        const providerCli = this.#project(id);
        const mutationId = this.#entry(id).mutationId;
        for (const listener of this.#listeners) {
            try {
                listener(providerCli, mutationId);
            } catch {
                // A listener failure must not break the operation it observes.
            }
        }
    }

    #refusal(
        code: ProviderCliRequestError["code"],
        id: ProviderCliId,
        message: string,
    ): ProviderCliRequestError {
        return new ProviderCliRequestError(code, message, this.#project(id));
    }

    #entry(id: ProviderCliId): Entry {
        const entry = this.#entries.get(id);
        if (entry === undefined) throw new Error(`Unknown provider CLI "${id}".`);
        return entry;
    }

    #project(id: ProviderCliId): ProviderCli {
        const cli = definition(id);
        const entry = this.#entry(id);
        const installed = entry.installation.status === "installed";
        return {
            id,
            name: cli.name,
            vendor: cli.vendor,
            website: cli.website,
            providerId: this.#providerIdFor(id),
            installation: entry.installation,
            installer: cli.installer(process.platform),
            commands: cli.commands,
            signIn: { ...entry.signIn, methods: installed ? cli.methods.slice() : [] },
            operation: entry.operation,
            version: entry.version,
            updatedAt: entry.updatedAt,
        };
    }

    /** The configured built-in account this assistant's sign-in serves. */
    #providerIdFor(id: ProviderCliId): string | null {
        const ids = this.#config.providerIds;
        if (ids.includes(id) && this.#config.providers.typeOf(id) === id) return id;
        return ids.find((providerId) => this.#config.providers.typeOf(providerId) === id) ?? null;
    }
}

function definition(id: ProviderCliId): ProviderCliDefinition {
    const found = PROVIDER_CLI_DEFINITIONS.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`Unknown provider CLI "${id}".`);
    return found;
}

function activeOperation(entry: Entry): ProviderCliOperation | undefined {
    const operation = entry.operation;
    return operation !== null && (operation.status === "running" || operation.status === "waiting")
        ? operation
        : undefined;
}

function durableOperationId(id: ProviderCliId): string {
    return `provider-cli:${id}`;
}

function signedInMessage(name: string, account: ProviderCliSignIn["account"]): string {
    if (account?.email == null) return `Signed in to ${name}.`;
    return account.plan === null
        ? `Signed in to ${name} as ${account.email}.`
        : `Signed in to ${name} as ${account.email} · ${account.plan}.`;
}
