import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import { Type } from "@sinclair/typebox";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../../config/index.js";
import type { DurableFunctionsModule } from "../../durableFunctions/index.js";
import { requireDurableCommit } from "../../impl/durableCommit.js";
import type { ProviderScanModule } from "../../providerScan/index.js";
import {
    providerCliSignInMethodSchema,
    type ProviderCliOperation,
    type ProviderCliOperationError,
    type ProviderCliSignIn,
    type ProviderCliSignInMethod,
} from "../ProviderCli.js";
import {
    PROVIDER_SIGN_IN_CLI_IDS,
    ProviderSignInRequestError,
    type ProviderCredential,
    type ProviderSignIn,
    type ProviderSignInCliId,
} from "../ProviderSignIn.js";
import { checkProviderCliSignIn } from "./checkProviderCliSignIn.js";
import { createProviderCliVersion } from "./createProviderCliVersion.js";
import {
    PROVIDER_CLI_DEFINITIONS,
    type ProviderCliDefinition,
    type ProviderCliMachine,
} from "./providerCliCatalog.js";
import {
    appendOutputLine,
    startProviderCliProcess,
    type ProviderCliProcess,
} from "./startProviderCliProcess.js";

const SIGN_IN_FUNCTION = "provider-account-sign-in";
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1_000;
const OUTPUT_COALESCE_MS = 250;

/**
 * Credentials an exported variable could supply instead of the sign-in: the program must sign in
 * rather than report a key that happens to be in the daemon's environment.
 */
const AMBIENT_CREDENTIAL_VARIABLES = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
] as const;

/** The variable that points each vendor's program at the folder it keeps its sign-in in. */
const HOME_VARIABLES: Readonly<Record<ProviderSignInCliId, string>> = {
    claude: "CLAUDE_CONFIG_DIR",
    codex: "CODEX_HOME",
    grok: "GROK_HOME",
};

const argumentsSchema = Type.Object(
    {
        providerId: Type.String({ minLength: 1, maxLength: 16_384 }),
        operationId: Type.String({ minLength: 1, maxLength: 64 }),
        method: Type.Optional(providerCliSignInMethodSchema),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);
type SignInArguments = typeof argumentsSchema.static;

type Listener = (providerSignIn: ProviderSignIn, mutationId: string | undefined) => void;

interface Entry {
    readonly cliId: ProviderSignInCliId;
    installed: boolean;
    account: ProviderCliSignIn["account"];
    operation: ProviderCliOperation | null;
    /** The request that started or last changed the sign-in, echoed by its events. */
    mutationId: string | undefined;
    /** The credential last projected, so a configuration change mints a new version. */
    credential: string | undefined;
    version: string;
    updatedAt: number;
}

/** What the module lends the account sign-ins: its configuration and its programs. */
export interface ProviderAccountSignInsOptions {
    readonly config: ConfigModule;
    readonly providerScan: ProviderScanModule;
    readonly durable: DurableFunctionsModule;
    /** The installed program of an assistant after refreshing discovery, or null when missing. */
    readonly program: (ctx: Context, cliId: ProviderSignInCliId) => Promise<string | null>;
    readonly machine: () => ProviderCliMachine;
}

/**
 * Signs one configured account in to a credential this installation owns. The vendor's own
 * sign-in runs with its home pointed at a new private folder of the account's, so the vendor's
 * global sign-in is never touched; only a successful sign-in points the account at that folder.
 *
 * Each sign-in is a Durable Function keyed by the account, so at most one runs per account and a
 * second request joins it. A sign-in cannot survive the program waiting for the browser, so a
 * rerun after a restart ends it as interrupted and deletes its folder.
 */
export class ProviderAccountSignIns {
    readonly #config: ConfigModule;
    readonly #providerScan: ProviderScanModule;
    readonly #durable: DurableFunctionsModule;
    readonly #program: ProviderAccountSignInsOptions["program"];
    readonly #machine: ProviderAccountSignInsOptions["machine"];
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #entries = new Map<string, Entry>();
    readonly #processes = new Map<string, ProviderCliProcess>();
    readonly #pendingEmits = new Map<string, NodeJS.Timeout>();
    readonly #listeners = new Set<Listener>();
    /**
     * Sign-in folders accounts used while this daemon ran. Sessions opened before a newer sign-in
     * may still renew them, so they are kept until a later daemon's sign-in clears them.
     */
    readonly #inUse = new Set<string>();

    constructor(options: ProviderAccountSignInsOptions) {
        this.#config = options.config;
        this.#providerScan = options.providerScan;
        this.#durable = options.durable;
        this.#program = options.program;
        this.#machine = options.machine;
        options.durable.register({
            name: SIGN_IN_FUNCTION,
            argumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                // A rerun after a restart finds the first run's marker: the program that was
                // waiting for the browser died with the daemon, so the attempt is over.
                const attempt = createId();
                const stored = await call.kv.getOrCreate(ctx, "attempt", () => attempt);
                if (stored !== attempt) {
                    const cliId = this.#signInCliId(call.arguments.providerId);
                    if (cliId !== undefined) {
                        this.#adopt(call.arguments, cliId);
                        this.#finish(call.arguments, "failed", {
                            code: "interrupted",
                            message: "Signing in stopped because Happy restarted. Start it again.",
                        });
                    }
                    await this.#discard(call.arguments);
                    return null;
                }
                await requireDurableCommit(ctx);
                await this.#signIn(ctx, call.arguments);
                return null;
            },
        });
    }

    /** Hear every change of an account's sign-in object, after it has happened. */
    onUpdated(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** The sign-in methods and token support of an account, for its configuration entry. */
    credential(providerId: string): ProviderCredential | undefined {
        const cliId = this.#signInCliId(providerId);
        const source = this.#config.providerCredentialSource(providerId);
        if (cliId === undefined || source === undefined) return undefined;
        return { source, methods: methodsOf(cliId), acceptsToken: cliId === "claude" };
    }

    /** One account's sign-in after finding its program and asking which account is signed in. */
    async get(ctx: Context, providerId: string): Promise<ProviderSignIn> {
        const cliId = this.#requireCliId(providerId);
        const executable = await this.#program(ctx, cliId);
        const entry = this.#entry(providerId, cliId);
        if (activeOperation(entry) === undefined) {
            const before = JSON.stringify([entry.installed, entry.account]);
            entry.installed = executable !== null;
            entry.account = await this.#internalAccount(providerId, cliId, executable, entry);
            if (JSON.stringify([entry.installed, entry.account]) !== before) {
                this.#touch(entry);
                this.#emitNow(providerId);
            }
        }
        return this.#project(providerId);
    }

    /** Start, or join, the vendor's sign-in for one account into a new private folder. */
    async start(
        ctx: Context,
        providerId: string,
        method: ProviderCliSignInMethod | undefined,
        mutationId?: string,
    ): Promise<ProviderSignIn> {
        const cliId = this.#requireCliId(providerId);
        const executable = await this.#program(ctx, cliId);
        return await this.#lock.runInLock(ctx, async () => {
            const entry = this.#entry(providerId, cliId);
            if (activeOperation(entry) !== undefined) return this.#project(providerId);
            if (entry.installed !== (executable !== null)) {
                entry.installed = executable !== null;
                this.#touch(entry);
            }
            if (executable === null) {
                throw this.#refusal(
                    "not_installed",
                    providerId,
                    `${definition(cliId).name} isn't installed yet.`,
                );
            }
            const chosen = method ?? methodsOf(cliId)[0];
            if (chosen === undefined || !methodsOf(cliId).includes(chosen)) {
                throw this.#refusal(
                    "invalid_request",
                    providerId,
                    `${definition(cliId).name} can't sign in that way.`,
                );
            }
            await this.#removeUnusedFolders(ctx, providerId);
            const operationId = createId();
            const args: SignInArguments = {
                providerId,
                operationId,
                method: chosen,
                ...(mutationId === undefined ? {} : { mutationId }),
            };
            const result = await this.#durable.invoke(ctx, {
                function: SIGN_IN_FUNCTION,
                operationId: durableOperationId(providerId),
                lockKeys: [durableOperationId(providerId)],
                arguments: args,
            });
            // A call still pending from before a restart owns this account; it reports itself.
            if (result.status === "duplicate") return this.#project(providerId);
            this.#adopt(args, cliId);
            return this.#project(providerId);
        });
    }

    /** Hand the code a vendor's page showed to the sign-in waiting for it. */
    async submitCode(
        ctx: Context,
        providerId: string,
        code: string,
        mutationId?: string,
    ): Promise<ProviderSignIn> {
        const cliId = this.#requireCliId(providerId);
        return await this.#lock.runInLock(ctx, async () => {
            const entry = this.#entry(providerId, cliId);
            const process = this.#processes.get(providerId);
            if (
                entry.operation?.status !== "waiting" ||
                entry.operation.authorization?.acceptsCode !== true ||
                process === undefined
            ) {
                throw this.#refusal("conflict", providerId, "No sign-in is waiting for a code.");
            }
            process.write(`${code}\n`);
            entry.mutationId = mutationId ?? entry.mutationId;
            this.#change(providerId, {
                status: "running",
                message: "Checking the code…",
                authorization: null,
            });
            return this.#project(providerId);
        });
    }

    /** Stop the running sign-in, if any; the account keeps the credential it had. */
    async cancel(ctx: Context, providerId: string, mutationId?: string): Promise<ProviderSignIn> {
        const cliId = this.#requireCliId(providerId);
        return await this.#lock.runInLock(ctx, async () => {
            const entry = this.#entry(providerId, cliId);
            const operation = activeOperation(entry);
            if (operation === undefined) return this.#project(providerId);
            entry.mutationId = mutationId ?? entry.mutationId;
            await this.#durable.cancel(ctx, durableOperationId(providerId));
            this.#processes.get(providerId)?.kill();
            const args = { providerId, operationId: operation.id };
            this.#finish(args, "cancelled", null);
            await this.#discard(args);
            return this.#project(providerId);
        });
    }

    /** Save a pasted Claude setup token as one Claude account's own credential. */
    async saveToken(
        ctx: Context,
        providerId: string,
        token: string,
        mutationId?: string,
    ): Promise<ProviderSignIn> {
        const cliId = this.#requireCliId(providerId);
        if (cliId !== "claude") {
            throw new ProviderSignInRequestError(
                "not_supported",
                "Only Claude accounts accept a setup token.",
            );
        }
        const executable = await this.#program(ctx, cliId);
        return await this.#lock.runInLock(ctx, async () => {
            await this.#config.saveProviderSetupToken(ctx, providerId, token);
            await this.#providerScan.scanAfterCredentialChange(ctx);
            return this.#announce(providerId, cliId, executable !== null, mutationId);
        });
    }

    /** Announce an account whose credential changed outside these routes, such as the setup-token route. */
    async announce(ctx: Context, providerId: string, mutationId?: string): Promise<void> {
        const cliId = this.#signInCliId(providerId);
        if (cliId === undefined) return;
        const executable = await this.#program(ctx, cliId);
        await this.#lock.runInLock(ctx, async () => {
            this.#announce(providerId, cliId, executable !== null, mutationId);
        });
    }

    #announce(
        providerId: string,
        cliId: ProviderSignInCliId,
        installed: boolean,
        mutationId: string | undefined,
    ): ProviderSignIn {
        const entry = this.#entry(providerId, cliId);
        entry.installed = installed;
        // A pasted token reveals no account, and it now outranks the account's sign-in.
        entry.account = null;
        this.#touch(entry);
        const providerSignIn = this.#project(providerId);
        this.#emitSnapshot(providerSignIn, mutationId);
        return providerSignIn;
    }

    async #signIn(ctx: Context, args: SignInArguments): Promise<void> {
        const { providerId } = args;
        const cliId = this.#signInCliId(providerId);
        if (cliId === undefined) {
            await this.#discard(args);
            return;
        }
        const cli = definition(cliId);
        this.#adopt(args, cliId);
        const executable = await this.#program(ctx, cliId);
        const method = args.method ?? methodsOf(cliId)[0];
        const flow = method === undefined ? undefined : cli.signIn[method];
        if (executable === null || method === undefined || flow === undefined) {
            this.#finish(args, "failed", {
                code: "unavailable",
                message: `${cli.name} isn't installed, so it can't sign in.`,
            });
            await this.#discard(args);
            return;
        }
        const directory = this.#config.providerSignInDirectory(providerId, args.operationId);
        const machine = this.#isolatedMachine(cliId, directory);
        try {
            await ensurePrivateDirectory(directory);
            // Codex may keep a sign-in in the system keyring; this folder's must stay a file.
            if (cliId === "codex") {
                await writeFile(
                    join(directory, "config.toml"),
                    'cli_auth_credentials_store = "file"\n',
                    { mode: 0o600 },
                );
            }
        } catch (error: unknown) {
            ctx.log.warn("Preparing a provider sign-in folder failed.", { providerId }, error);
            this.#finish(args, "failed", {
                code: "unavailable",
                message: `Happy couldn't prepare a private folder to sign in to ${cli.name}.`,
            });
            await this.#discard(args);
            return;
        }
        const startedAt = this.#entries.get(providerId)?.operation?.startedAt ?? Date.now();
        const timeoutMs = Math.min(
            SIGN_IN_TIMEOUT_MS,
            (flow.waitsMs ?? SIGN_IN_TIMEOUT_MS) + 5_000,
        );
        const watchForPage = (text: string) => {
            const operation = this.#entries.get(providerId)?.operation;
            if (operation?.id !== args.operationId || operation.status !== "running") return;
            if (operation.authorization !== null) return;
            const url = flow.url.exec(text)?.[1];
            if (url === undefined) return;
            const userCode = flow.userCode?.exec(text)?.[1] ?? null;
            if (flow.userCode !== undefined && userCode === null) return;
            this.#change(providerId, {
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
            args,
            executable,
            flow.args,
            machine.env,
            timeoutMs,
            watchForPage,
        );
        if (!this.#isCurrent(providerId, args.operationId)) return;
        this.#change(providerId, {
            status: "running",
            authorization: null,
            message: "Checking the sign-in…",
        });
        const check = await checkProviderCliSignIn(cliId, executable, machine);
        await this.#lock.runInLock(ctx, async () => {
            // A cancel while the check ran has already settled the sign-in and deleted its folder.
            if (!this.#isCurrent(providerId, args.operationId)) return;
            if (check.status !== "signed_in") {
                this.#finish(args, "failed", {
                    code:
                        code === "timeout"
                            ? "expired"
                            : code === null
                              ? "unavailable"
                              : "sign_in_failed",
                    message:
                        code === "timeout"
                            ? `Signing in to ${cli.name} wasn't finished in time. Start it again.`
                            : code === null
                              ? `${cli.name} couldn't be started to sign in.`
                              : `${cli.name} didn't finish signing in.`,
                });
                await this.#discard(args);
                return;
            }
            const previous = this.#config.providerSignInHome(providerId);
            try {
                await this.#config.adoptProviderSignIn(ctx, providerId, directory);
            } catch (error: unknown) {
                ctx.log.warn("Saving a provider sign-in failed.", { providerId }, error);
                this.#finish(args, "failed", {
                    code: "save_failed",
                    message: `Signed in to ${cli.name}, but Happy couldn't save it. The account still uses its earlier sign-in.`,
                });
                await this.#discard(args);
                return;
            }
            if (previous !== undefined) this.#inUse.add(previous);
            this.#inUse.add(directory);
            const entry = this.#entry(providerId, cliId);
            entry.account = check.account;
            try {
                await this.#providerScan.scanAfterCredentialChange(ctx);
            } catch (error: unknown) {
                ctx.log.warn("Provider scan after a provider sign-in failed.", {}, error);
            }
            this.#finish(args, "succeeded", null);
        });
    }

    /**
     * Run the vendor's program until it exits, the sign-in is cancelled, or time runs out. Its
     * lifetime belongs to the durable call's context, never to the request that started it.
     */
    async #runProcess(
        ctx: Context,
        args: SignInArguments,
        command: string,
        commandArgs: readonly string[],
        env: Readonly<NodeJS.ProcessEnv>,
        timeoutMs: number,
        onText: (text: string) => void,
    ): Promise<number | null | "timeout"> {
        const { providerId, operationId } = args;
        const child = startProviderCliProcess(command, commandArgs, env, (line) => {
            const entry = this.#entries.get(providerId);
            if (entry?.operation?.id !== operationId) return;
            entry.operation = {
                ...entry.operation,
                output: appendOutputLine(entry.operation.output, line),
            };
            this.#touch(entry);
            onText(child.text());
            this.#emitSoon(providerId);
        });
        this.#processes.set(providerId, child);
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
            if (this.#processes.get(providerId) === child) this.#processes.delete(providerId);
        }
    }

    /** Which account the installation's own sign-in holds, when the account uses one. */
    async #internalAccount(
        providerId: string,
        cliId: ProviderSignInCliId,
        executable: string | null,
        entry: Entry,
    ): Promise<ProviderCliSignIn["account"]> {
        const home = this.#config.providerSignInHome(providerId);
        if (home === undefined) return null;
        const check = await checkProviderCliSignIn(
            cliId,
            executable,
            this.#isolatedMachine(cliId, home),
        );
        if (check.status === "signed_in") return check.account;
        return check.status === "signed_out" ? null : entry.account;
    }

    /** The machine as the vendor's program sees it while it works in one sign-in folder. */
    #isolatedMachine(cliId: ProviderSignInCliId, directory: string): ProviderCliMachine {
        const machine = this.#machine();
        const env: NodeJS.ProcessEnv = { ...machine.env, [HOME_VARIABLES[cliId]]: directory };
        for (const name of AMBIENT_CREDENTIAL_VARIABLES) delete env[name];
        return { ...machine, env };
    }

    /**
     * Delete the account's sign-in folders that nothing uses: neither the one its configuration
     * names nor one this daemon has used, which a session opened earlier may still renew.
     */
    async #removeUnusedFolders(ctx: Context, providerId: string): Promise<void> {
        const current = this.#config.providerSignInHome(providerId);
        if (current !== undefined) this.#inUse.add(current);
        for (const folder of await this.#config.providerSignInDirectories(providerId)) {
            if (this.#inUse.has(folder)) continue;
            try {
                await rm(folder, { force: true, recursive: true });
            } catch (error: unknown) {
                ctx.log.warn(
                    "Removing an unused provider sign-in folder failed.",
                    { providerId },
                    error,
                );
            }
        }
    }

    /** Delete an attempt's folder unless the account has adopted it. */
    async #discard(args: Pick<SignInArguments, "providerId" | "operationId">): Promise<void> {
        let directory: string;
        try {
            directory = this.#config.providerSignInDirectory(args.providerId, args.operationId);
        } catch {
            return;
        }
        if (
            this.#inUse.has(directory) ||
            this.#config.providerSignInHome(args.providerId) === directory
        ) {
            return;
        }
        await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }

    /** Make the sign-in a durable call is running the current one, as after a restart. */
    #adopt(args: SignInArguments, cliId: ProviderSignInCliId): void {
        const entry = this.#entry(args.providerId, cliId);
        if (entry.operation?.id === args.operationId) return;
        entry.mutationId = args.mutationId;
        entry.operation = {
            id: args.operationId,
            kind: "sign_in",
            status: "running",
            message: `Starting to sign in to ${definition(cliId).name}…`,
            authorization: null,
            output: [],
            error: null,
            startedAt: Date.now(),
            finishedAt: null,
        };
        this.#touch(entry);
        this.#emitNow(args.providerId);
    }

    #change(
        providerId: string,
        changes: Partial<Pick<ProviderCliOperation, "status" | "message" | "authorization">>,
    ): void {
        const entry = this.#entries.get(providerId);
        if (entry?.operation == null) return;
        entry.operation = { ...entry.operation, ...changes };
        this.#touch(entry);
        this.#emitNow(providerId);
    }

    /** Settle the sign-in once; a later settlement of the same sign-in changes nothing. */
    #finish(
        args: Pick<SignInArguments, "providerId" | "operationId">,
        status: "succeeded" | "failed" | "cancelled",
        error: ProviderCliOperationError | null,
    ): void {
        const entry = this.#entries.get(args.providerId);
        const operation = entry?.operation;
        if (entry === undefined || operation?.id !== args.operationId) return;
        if (activeOperation(entry) === undefined) return;
        // A sign-in changes the credential; settle that first so the result is the last change.
        this.#settleCredential(args.providerId, entry);
        const name = definition(entry.cliId).name;
        const now = Date.now();
        entry.operation = {
            ...operation,
            status,
            message:
                error?.message ??
                (status === "cancelled"
                    ? `Signing in to ${name} was cancelled.`
                    : signedInMessage(name, entry.account)),
            authorization: null,
            error,
            finishedAt: now,
        };
        this.#touch(entry, now);
        this.#emitNow(args.providerId);
    }

    #isCurrent(providerId: string, operationId: string): boolean {
        const entry = this.#entries.get(providerId);
        return (
            entry !== undefined &&
            entry.operation?.id === operationId &&
            activeOperation(entry) !== undefined
        );
    }

    #touch(entry: Entry, now = Date.now()): void {
        entry.version = createProviderCliVersion(now);
        entry.updatedAt = now;
    }

    /** Output arrives line by line; coalesce it to a few events a second. */
    #emitSoon(providerId: string): void {
        if (this.#pendingEmits.has(providerId)) return;
        const timer = setTimeout(() => {
            this.#pendingEmits.delete(providerId);
            this.#emit(providerId);
        }, OUTPUT_COALESCE_MS);
        timer.unref();
        this.#pendingEmits.set(providerId, timer);
    }

    #emitNow(providerId: string): void {
        const pending = this.#pendingEmits.get(providerId);
        if (pending !== undefined) {
            clearTimeout(pending);
            this.#pendingEmits.delete(providerId);
        }
        this.#emit(providerId);
    }

    #emit(providerId: string): void {
        const entry = this.#entries.get(providerId);
        // An account removed from configuration while signing in has nothing left to announce.
        if (entry === undefined || this.#signInCliId(providerId) === undefined) return;
        this.#emitSnapshot(this.#project(providerId), entry.mutationId);
    }

    #emitSnapshot(providerSignIn: ProviderSignIn, mutationId: string | undefined): void {
        for (const listener of this.#listeners) {
            try {
                listener(providerSignIn, mutationId);
            } catch {
                // A listener failure must not break the sign-in it observes.
            }
        }
    }

    #refusal(
        code: ProviderSignInRequestError["code"],
        providerId: string,
        message: string,
    ): ProviderSignInRequestError {
        return new ProviderSignInRequestError(code, message, this.#project(providerId));
    }

    /** The assistant that signs an account in, or a refusal naming why it cannot. */
    #requireCliId(providerId: string): ProviderSignInCliId {
        if (this.#config.configuration.values.providers[providerId] === undefined) {
            throw new ProviderSignInRequestError("not_found", "Provider not found.");
        }
        const cliId = this.#signInCliId(providerId);
        if (cliId === undefined) {
            throw new ProviderSignInRequestError(
                "not_supported",
                "This account has nothing to sign in to.",
            );
        }
        return cliId;
    }

    #signInCliId(providerId: string): ProviderSignInCliId | undefined {
        // The type the catalog shows, so a test-scripted account reads like the Codex account it
        // becomes once its runtime table is loaded.
        const type = this.#config.providerType(providerId);
        return PROVIDER_SIGN_IN_CLI_IDS.find((id) => id === type);
    }

    #entry(providerId: string, cliId: ProviderSignInCliId): Entry {
        const existing = this.#entries.get(providerId);
        if (existing !== undefined && existing.cliId === cliId) return existing;
        const now = Date.now();
        const entry: Entry = {
            cliId,
            installed: false,
            account: null,
            operation: null,
            mutationId: undefined,
            credential: undefined,
            version: createProviderCliVersion(now),
            updatedAt: now,
        };
        this.#entries.set(providerId, entry);
        return entry;
    }

    /** The account's credential now, minting a new version when it changed since last seen. */
    #settleCredential(providerId: string, entry: Entry): ProviderCredential {
        const credential = this.credential(providerId) ?? {
            source: "configured" as const,
            methods: methodsOf(entry.cliId),
            acceptsToken: entry.cliId === "claude",
        };
        const fingerprint = JSON.stringify(credential);
        if (entry.credential !== fingerprint) {
            if (entry.credential !== undefined) this.#touch(entry);
            entry.credential = fingerprint;
        }
        return credential;
    }

    #project(providerId: string): ProviderSignIn {
        const cliId = this.#requireCliId(providerId);
        const entry = this.#entry(providerId, cliId);
        const credential = this.#settleCredential(providerId, entry);
        return {
            providerId,
            cliId,
            installed: entry.installed,
            credential,
            account: credential.source === "internal" ? entry.account : null,
            operation: entry.operation,
            version: entry.version,
            updatedAt: entry.updatedAt,
        };
    }
}

function definition(id: ProviderSignInCliId): ProviderCliDefinition {
    const found = PROVIDER_CLI_DEFINITIONS.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`Unknown provider CLI "${id}".`);
    return found;
}

/** Device sign-in comes first where the vendor offers it, since it finishes on any device. */
function methodsOf(id: ProviderSignInCliId): ProviderCliSignInMethod[] {
    const methods = definition(id).methods;
    return [
        ...methods.filter((method) => method === "device"),
        ...methods.filter((method) => method !== "device"),
    ];
}

function activeOperation(entry: Entry): ProviderCliOperation | undefined {
    const operation = entry.operation;
    return operation !== null && (operation.status === "running" || operation.status === "waiting")
        ? operation
        : undefined;
}

/** Durable operation IDs are bounded; an account ID too long to fit is named by its hash. */
function durableOperationId(providerId: string): string {
    return providerId.length <= 128
        ? `provider-sign-in:${providerId}`
        : `provider-sign-in:#${createHash("sha256").update(providerId).digest("hex")}`;
}

function signedInMessage(name: string, account: ProviderCliSignIn["account"]): string {
    if (account?.email == null) return `Signed in to ${name}.`;
    return account.plan === null
        ? `Signed in to ${name} as ${account.email}.`
        : `Signed in to ${name} as ${account.email} · ${account.plan}.`;
}
