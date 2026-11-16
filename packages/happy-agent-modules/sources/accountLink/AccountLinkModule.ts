import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, detach, withLifetime, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { NodeModule } from "../node/index.js";
import {
    accountLinkStatusSchema,
    type AccountLinkCredentials,
    type AccountLinkStatus,
} from "./AccountLink.js";
import {
    deleteAccountLinkCredentials,
    readAccountLinkCredentials,
    writeAccountLinkCredentials,
} from "./impl/accountLinkCredentialsFile.js";
import {
    AccountsRefusal,
    markEndpointSeen,
    patchEndpointReachable,
    redeemDeviceCode,
    refreshEndpointTokens,
    requestDeviceAuthorization,
    revokeRefreshToken,
    type EndpointTokens,
} from "./impl/accountsClient.js";
import { AccountTokenVerifier } from "./impl/AccountTokenVerifier.js";
import { RelayConnector } from "./impl/RelayConnector.js";
import { getHappyAccountStatusTool } from "./tools/get_happy_account_status.js";
import { linkHappyAccountTool } from "./tools/link_happy_account.js";
import { setHappyAccountReachableTool } from "./tools/set_happy_account_reachable.js";
import { unlinkHappyAccountTool } from "./tools/unlink_happy_account.js";

const RECONCILE_FUNCTION = "account-link-reconcile";
const RECONCILE_LOCK = "account-link-relay";
/** Refresh this long before the endpoint token expires, so an attach never races its expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** The refresh token lives thirty days; a linked but idle machine renews it daily. */
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** The contract's limit on telling accounts this machine was seen. */
const SEEN_INTERVAL_MS = 10 * 60 * 1_000;
/** How long turning reachable on waits for the first attach before answering "connecting". */
const ATTACH_FEEDBACK_MS = 5_000;

interface LinkAttempt {
    readonly cancel: AbortController;
    readonly deviceCode: string;
    readonly expiresAt: number;
    readonly userCode: string;
    readonly verificationUrl: string;
}

/**
 * Links this daemon to one Happy account and, while its owner has marked it reachable, keeps one
 * outbound socket to the Happy Relay. The module owns the device-grant link, the stored endpoint
 * credential and its rotation, the relay socket, and the admin-only tools.
 */
export class AccountLinkModule implements AgentModule {
    readonly name = "accountLink";

    readonly #bots: BotsModule;
    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #node: NodeModule;
    readonly #lock: AsyncLock = asyncLock({ reentry: "block" });
    readonly #verifier: AccountTokenVerifier | undefined;
    #access: { readonly expiresAt: number; readonly token: string } | undefined;
    #accountsKnowReachable: boolean | undefined;
    #attempt: LinkAttempt | undefined;
    #closed = false;
    #connector: RelayConnector | undefined;
    #context: Context | undefined;
    #error: string | undefined;
    #lastSeenAt = 0;
    #link: AccountLinkCredentials | undefined;
    #maintenance: NodeJS.Timeout | undefined;
    #refreshing: Promise<string> | undefined;
    #writes: Promise<void> = Promise.resolve();

    constructor(
        config: ConfigModule,
        bots: BotsModule,
        node: NodeModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#bots = bots;
        this.#config = config;
        this.#durableFunctions = durableFunctions;
        this.#node = node;
        const settings = this.#settings();
        this.#verifier =
            settings === undefined
                ? undefined
                : new AccountTokenVerifier(settings.accountsUrl, settings.relayUrl);
        durableFunctions.register({
            name: RECONCILE_FUNCTION,
            argumentsSchema: Type.Object({}, { additionalProperties: false }),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.#reconcile(ctx);
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        // The local API is listening by now, so an attach can be served as soon as it lands.
        afterStart: async (ctx: Context): Promise<void> => {
            await this.#reconcile(ctx).catch((error: unknown) => {
                this.#moduleContext(ctx).log.warn(
                    "The Happy account link could not resume.",
                    {},
                    error,
                );
            });
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if (this.#settings() === undefined) return [];
            if (!(await this.#isActiveAdminBot(ctx, scope.agent.id))) return [];
            return [
                linkHappyAccountTool(this, scope.agent.id),
                getHappyAccountStatusTool(this, scope.agent.id),
                setHappyAccountReachableTool(this, scope.agent.id),
                unlinkHappyAccountTool(this, scope.agent.id),
            ];
        },
    };

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const detached = detach(ctx).named("account-link");
        this.#context =
            ctx.lifetime === undefined ? detached : withLifetime(detached, ctx.lifetime);
        const settings = this.#settings();
        if (settings === undefined) return this.#hooks;
        try {
            const stored = await readAccountLinkCredentials(
                this.#config.accountLinkCredentialsPath,
            );
            if (stored !== undefined && stored.accountsUrl !== settings.accountsUrl) {
                // The credential belongs to another accounts service and must never be sent here.
                this.#error =
                    "This computer was linked through a different Happy accounts service. Link it again.";
            } else {
                this.#link = stored;
            }
        } catch (error: unknown) {
            this.#error = errorMessage(error);
        }
        this.#maintenance = setInterval(() => {
            if (this.#link === undefined) return;
            void this.#endpointToken(true).catch(() => undefined);
        }, MAINTENANCE_INTERVAL_MS);
        this.#maintenance.unref();
        return this.#hooks;
    };

    /**
     * Start linking, or return the code already waiting for approval. The person approves the
     * code in a browser signed in to their Happy account; whoever approves becomes the owner.
     */
    async startLink(ctx: Context, actingAgentId: string): Promise<AccountLinkStatus> {
        await this.#requireActiveAdminBot(ctx, actingAgentId, "manage");
        const settings = this.#requireSettings();
        return await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            if (this.#closed) throw new Error("Happy Agent is stopping.");
            if (this.#link !== undefined) {
                throw new Error(
                    "This computer is already linked to a Happy account. Unlink it before linking another.",
                );
            }
            if (this.#attempt !== undefined && this.#attempt.expiresAt > Date.now()) {
                return this.currentStatus();
            }
            this.#attempt?.cancel.abort();
            const node = await this.#node.get(ctx);
            const authorization = await requestDeviceAuthorization(settings.accountsUrl, {
                // Accounts accepts a device name of one to sixty-four characters.
                name: [...node.name].slice(0, 64).join("") || "Happy Agent",
                platform: accountsPlatform(),
            });
            const attempt: LinkAttempt = {
                cancel: new AbortController(),
                deviceCode: authorization.device_code,
                expiresAt: Date.now() + authorization.expires_in * 1_000,
                userCode: authorization.user_code,
                verificationUrl:
                    authorization.verification_uri_complete ?? authorization.verification_uri,
            };
            this.#attempt = attempt;
            this.#error = undefined;
            void this.#awaitApproval(attempt, (authorization.interval ?? 5) * 1_000);
            return this.currentStatus();
        });
    }

    /** Persist the owner's choice, durably schedule convergence, and reconcile it immediately. */
    async setReachable(
        ctx: Context,
        actingAgentId: string,
        reachable: boolean,
    ): Promise<AccountLinkStatus> {
        await this.#requireActiveAdminBot(ctx, actingAgentId, "manage");
        this.#requireSettings();
        const connector = await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            if (this.#link === undefined) {
                throw new Error(
                    "Link this computer to a Happy account before making it reachable.",
                );
            }
            this.#link = { ...this.#link, reachable };
            await this.#persist();
            await this.#durableFunctions.invoke(ctx, {
                function: RECONCILE_FUNCTION,
                arguments: {},
                lockKeys: [RECONCILE_LOCK],
            });
            await this.#reconcileLocked();
            return this.#connector;
        });
        // Outside the lock: the socket's first attach must not hold up status reads or unlink.
        await connector?.settled(ATTACH_FEEDBACK_MS);
        return this.currentStatus();
    }

    /**
     * Forget the link: close the relay socket, tell accounts the machine is unreachable, revoke
     * its credential there, and drop it here. Only the owner can delete the account's entry.
     */
    async unlink(ctx: Context, actingAgentId: string): Promise<AccountLinkStatus> {
        await this.#requireActiveAdminBot(ctx, actingAgentId, "manage");
        const settings = this.#requireSettings();
        return await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            this.#attempt?.cancel.abort();
            this.#attempt = undefined;
            const link = this.#link;
            if (link === undefined) {
                // A credential left by another accounts service goes too; it is never sent anywhere.
                this.#error = undefined;
                await this.#persist();
                return this.currentStatus();
            }
            // The socket goes first, so nothing is served while accounts is being told.
            await this.#closeConnector();
            let told = true;
            try {
                const token = await this.#endpointToken(false);
                await patchEndpointReachable(settings.accountsUrl, link.endpointId, token, false);
            } catch (error: unknown) {
                // An endpoint accounts already forgot needs no telling.
                told =
                    error instanceof AccountsRefusal &&
                    (error.status === 404 || error.code === "invalid_grant");
            }
            // The refresh may have rotated the token, or forgotten the link, just above.
            const refreshToken = this.#link?.refreshToken;
            if (refreshToken !== undefined) {
                try {
                    await revokeRefreshToken(settings.accountsUrl, refreshToken);
                } catch {
                    told = false;
                }
            }
            this.#forget(
                told
                    ? undefined
                    : "This computer is unlinked, but Happy accounts could not be told. Remove it from the account's devices.",
            );
            await this.#persist();
            return this.currentStatus();
        });
    }

    /** Read the link after independently checking the captured tool caller. */
    async getStatus(ctx: Context, actingAgentId: string): Promise<AccountLinkStatus> {
        await this.#requireActiveAdminBot(ctx, actingAgentId, "inspect");
        return this.currentStatus();
    }

    currentStatus(): AccountLinkStatus {
        const status = this.#status();
        if (!Value.Check(accountLinkStatusSchema, status)) {
            throw new Error("The Happy account link produced an invalid status.");
        }
        return status;
    }

    /** Stop live work only; the stored link and the owner's choice are the next start's state. */
    async close(ctx: Context): Promise<void> {
        await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            if (this.#closed) return;
            this.#closed = true;
            clearInterval(this.#maintenance);
            this.#attempt?.cancel.abort();
            this.#attempt = undefined;
            await this.#closeConnector();
            await this.#writes;
        });
    }

    #status(): AccountLinkStatus {
        const unavailable = this.#unavailableReason();
        if (unavailable !== undefined) return { reason: unavailable, state: "unavailable" };
        const link = this.#link;
        if (link !== undefined) {
            const error = this.#connector?.error ?? this.#error;
            return {
                accountId: link.accountId,
                endpointId: link.endpointId,
                ...(error === undefined ? {} : { error }),
                reachable: link.reachable,
                relay: this.#connector?.state ?? "off",
                state: "linked",
            };
        }
        const attempt = this.#attempt;
        if (attempt !== undefined && attempt.expiresAt > Date.now()) {
            return {
                expiresAt: attempt.expiresAt,
                state: "linking",
                userCode: attempt.userCode,
                verificationUrl: attempt.verificationUrl,
            };
        }
        return { ...(this.#error === undefined ? {} : { error: this.#error }), state: "unlinked" };
    }

    /** Poll the device grant until the person approves, refuses, or the code expires. */
    async #awaitApproval(attempt: LinkAttempt, intervalMs: number): Promise<void> {
        const settings = this.#requireSettings();
        const finish = (error: string | undefined): void => {
            if (this.#attempt !== attempt) return;
            this.#attempt = undefined;
            this.#error = error;
        };
        let interval = intervalMs;
        while (!attempt.cancel.signal.aborted) {
            await abortableDelay(interval, attempt.cancel.signal);
            if (attempt.cancel.signal.aborted) return;
            if (Date.now() >= attempt.expiresAt) {
                finish("The link code expired before it was approved. Start linking again.");
                return;
            }
            let tokens: EndpointTokens;
            try {
                tokens = await redeemDeviceCode(settings.accountsUrl, attempt.deviceCode);
            } catch (error: unknown) {
                if (!(error instanceof AccountsRefusal)) continue;
                if (error.code === "authorization_pending") continue;
                if (error.code === "slow_down") {
                    interval += 5_000;
                    continue;
                }
                finish(
                    error.code === "access_denied"
                        ? "The link was refused in the browser."
                        : error.code === "expired_token"
                          ? "The link code expired before it was approved. Start linking again."
                          : `Happy accounts refused the link (${error.code}).`,
                );
                return;
            }
            // The device code is spent now, whatever happens to these tokens.
            if (attempt.cancel.signal.aborted || this.#attempt !== attempt) return;
            try {
                const identity = await this.#requireVerifier().verifyEndpointToken(
                    tokens.access_token,
                );
                if (
                    tokens.endpoint_id !== undefined &&
                    tokens.endpoint_id !== identity.endpointId
                ) {
                    throw new Error("Happy accounts returned a token for another endpoint.");
                }
                if (this.#attempt !== attempt) return;
                this.#link = {
                    accountId: identity.accountId,
                    accountsUrl: settings.accountsUrl,
                    endpointId: identity.endpointId,
                    linkedAt: Date.now(),
                    reachable: false,
                    refreshToken: tokens.refresh_token,
                };
                this.#access = { expiresAt: identity.expiresAt, token: tokens.access_token };
                this.#accountsKnowReachable = undefined;
                await this.#persist();
                finish(undefined);
            } catch (error: unknown) {
                if (this.#attempt === attempt) this.#forget(undefined);
                finish(errorMessage(error));
            }
            return;
        }
    }

    async #reconcile(ctx: Context): Promise<void> {
        await this.#lock.runInLock(
            this.#moduleContext(ctx),
            async () => await this.#reconcileLocked(),
        );
    }

    /** Converge the relay socket and accounts' copy of `reachable` on the stored choice. */
    async #reconcileLocked(): Promise<void> {
        const settings = this.#settings();
        if (this.#closed || settings === undefined || this.#unavailableReason() !== undefined) {
            return;
        }
        const link = this.#link;
        if (link?.reachable !== true) {
            await this.#closeConnector();
            if (link !== undefined && this.#accountsKnowReachable !== false) {
                // The socket is already gone; accounts only stops handing out relay tokens.
                try {
                    await patchEndpointReachable(
                        settings.accountsUrl,
                        link.endpointId,
                        await this.#endpointToken(false),
                        false,
                    );
                    this.#accountsKnowReachable = false;
                    this.#error = undefined;
                } catch (error: unknown) {
                    if (this.#link !== undefined) {
                        this.#error = `This computer is no longer reachable, but Happy accounts could not be told: ${errorMessage(error)}`;
                    }
                }
            }
            return;
        }
        if (this.#connector !== undefined) return;
        this.#error = undefined;
        const context = this.#context;
        if (context === undefined) return;
        const verifier = this.#requireVerifier();
        const identity = { accountId: link.accountId, endpointId: link.endpointId };
        this.#connector = new RelayConnector(context, {
            attachUrl: relayAttachUrl(settings.relayUrl, link.endpointId),
            authorize: async (authorization) =>
                await verifier.verifyRelayAuthorization(authorization, identity),
            beforeAttach: async (token) => {
                if (this.#accountsKnowReachable === true) return;
                await patchEndpointReachable(settings.accountsUrl, link.endpointId, token, true);
                this.#accountsKnowReachable = true;
            },
            endpointToken: async (fresh) => await this.#endpointToken(fresh),
            localApi: {
                socketPath: this.#config.configuration.paths.socketPath,
                tokenPath: this.#config.configuration.paths.tokenPath,
            },
            onAttached: (token) => {
                if (Date.now() - this.#lastSeenAt < SEEN_INTERVAL_MS) return;
                this.#lastSeenAt = Date.now();
                void markEndpointSeen(settings.accountsUrl, link.endpointId, token).catch(
                    () => undefined,
                );
            },
        });
    }

    async #closeConnector(): Promise<void> {
        const connector = this.#connector;
        this.#connector = undefined;
        await connector?.close();
    }

    /**
     * This machine's endpoint token, refreshed when it is close to expiring. Concurrent callers
     * share one refresh: presenting a retired refresh token would revoke the whole link.
     */
    async #endpointToken(force: boolean): Promise<string> {
        const access = this.#access;
        if (
            !force &&
            access !== undefined &&
            access.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS
        ) {
            return access.token;
        }
        this.#refreshing ??= this.#refresh().finally(() => {
            this.#refreshing = undefined;
        });
        return await this.#refreshing;
    }

    async #refresh(): Promise<string> {
        const settings = this.#requireSettings();
        const link = this.#link;
        if (link === undefined) throw new Error("This computer is not linked to a Happy account.");
        let tokens: EndpointTokens;
        try {
            tokens = await refreshEndpointTokens(settings.accountsUrl, link.refreshToken);
        } catch (error: unknown) {
            if (error instanceof AccountsRefusal && error.code === "invalid_grant") {
                // The owner removed this computer, or the account is gone. Nothing may stay open.
                // Compared by endpoint: a reachable change replaces the record while this waits.
                if (this.#link?.endpointId === link.endpointId) {
                    this.#forget(
                        "Happy accounts no longer recognizes this computer. Link it again.",
                    );
                    void this.#closeConnector();
                    await this.#persist();
                }
            }
            throw error;
        }
        // Store the replacement before anything else can fail: the old token is already retired.
        if (this.#link?.endpointId === link.endpointId) {
            this.#link = { ...this.#link, refreshToken: tokens.refresh_token };
            await this.#persist();
        }
        const identity = await this.#requireVerifier().verifyEndpointToken(tokens.access_token);
        if (identity.endpointId !== link.endpointId || identity.accountId !== link.accountId) {
            throw new Error("Happy accounts returned a token for another endpoint or account.");
        }
        this.#access = { expiresAt: identity.expiresAt, token: tokens.access_token };
        return tokens.access_token;
    }

    #forget(error: string | undefined): void {
        this.#link = undefined;
        this.#access = undefined;
        this.#accountsKnowReachable = undefined;
        this.#lastSeenAt = 0;
        this.#error = error;
    }

    /** Write whatever the link is now. Writes run one at a time, so the newest state lands last. */
    #persist(): Promise<void> {
        const path = this.#config.accountLinkCredentialsPath;
        const write = this.#writes.then(async () => {
            const link = this.#link;
            if (link === undefined) await deleteAccountLinkCredentials(path);
            else await writeAccountLinkCredentials(path, link);
        });
        this.#writes = write.catch(() => undefined);
        return write;
    }

    #settings(): { readonly accountsUrl: string; readonly relayUrl: string } | undefined {
        return this.#config.accountLink;
    }

    #requireSettings(): { readonly accountsUrl: string; readonly relayUrl: string } {
        const reason = this.#unavailableReason();
        const settings = this.#settings();
        if (reason !== undefined || settings === undefined) {
            throw new Error(reason ?? "Happy account linking is not configured.");
        }
        return settings;
    }

    #requireVerifier(): AccountTokenVerifier {
        if (this.#verifier === undefined) {
            throw new Error("Happy account linking is not configured.");
        }
        return this.#verifier;
    }

    #unavailableReason(): string | undefined {
        if (this.#settings() === undefined) {
            return "Happy account linking is not configured on this computer.";
        }
        if (this.#config.configuration.values.feature.team.enabled) {
            // The relay caller becomes the local owner, and a team server has no single owner.
            return "A team server cannot be linked to a personal Happy account.";
        }
        return undefined;
    }

    async #isActiveAdminBot(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    async #requireActiveAdminBot(
        ctx: Context,
        agentId: string,
        action: "inspect" | "manage",
    ): Promise<void> {
        if (await this.#isActiveAdminBot(ctx, agentId)) return;
        throw new Error(`Only an active admin bot can ${action} the Happy account link.`);
    }

    #moduleContext(fallback: Context): Context {
        return this.#context ?? fallback;
    }
}

function relayAttachUrl(relayUrl: string, endpointId: string): string {
    const url = new URL(`/e/${encodeURIComponent(endpointId)}/attach`, relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

function accountsPlatform(): string {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "win32") return "windows";
    return "linux";
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}

function errorMessage(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.trim().slice(0, 8_192) || "The Happy account link failed without a message.";
}
