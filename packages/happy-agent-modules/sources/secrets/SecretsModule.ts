import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    GITHUB_SECRET_ID,
    PROJECT_GIT_SECRET_ID,
    secretAgentIdSchema,
    secretAttachReferenceResultSchema,
    secretAttachInputSchema,
    secretCommandEnvironmentSchema,
    secretEnvironmentVariableNamesSchema,
    secretIdSchema,
    secretListInputSchema,
    secretListQuerySchema,
    secretRegistrationInputSchema,
    secretRegistrationSchema,
    secretReservedIdSchema,
    secretScopeRefSchema,
    secretUpdateInputSchema,
    type SecretAgentId,
    type SecretAttachReferenceResult,
    type SecretAttachInput,
    type SecretAttachment,
    type SecretCommandEnvironment,
    type SecretHostEnvironment,
    type SecretId,
    type SecretListInput,
    type SecretListQuery,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretRegistrationInput,
    type SecretScopeRef,
    type SecretUpdateInput,
} from "./Secret.js";
import {
    assertSecretCommandEnvironment,
    assertSecretAttachment,
    assertSecretHostEnvironment,
    assertSecretPage,
    assertSecretReference,
    assertSecretStoreMutationResult,
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./SecretStore.js";
import { createSecretDatabase, secretsMigrations, type SecretDatabase } from "./SecretDatabase.js";
import {
    secretContextSchema,
    secretEventIdSchema,
    secretEventListenerSchema,
    secretEventSchema,
    secretEventTimestampSchema,
    type SecretEvent,
    type SecretEventListener,
    type SecretUnsubscribe,
} from "./SecretEvent.js";
import { attachSecretTool } from "./tools/attach_secret.js";
import { createSecretTool } from "./tools/create_secret.js";
import { detachSecretTool } from "./tools/detach_secret.js";
import { listSecretsTool } from "./tools/list_secrets.js";
import { referenceSecretTool } from "./tools/reference_secret.js";
import { updateSecretTool } from "./tools/update_secret.js";

/** How many references one page returns when the caller does not ask for fewer. */
export const SECRETS_PAGE_SIZE = 50;
/** The character budget every model-facing secrets result is trimmed to fit. */
export const SECRETS_OUTPUT_CHARACTERS = 12_000;
/** Stable owner of the installation-wide catalog used by agent tools and command resolution. */
export const GLOBAL_SECRET_OWNER_ID = "global";
/** The most secrets one resolver selection may name. */
const MAX_SECRET_LIST_ITEMS = 256;

type SecretChange<Result> = {
    readonly result: Result;
    readonly event?: SecretEvent | undefined;
};

/**
 * Module-owned secret metadata and attachment management.
 *
 * Secret values are never returned to the model. The module resolves them itself, out of its own
 * SQLite catalog, through `resolveForHost` and `resolveForCommand`; both are deliberately not
 * exposed as tools, and nothing outside the module supplies or intercepts a value.
 *
 * Storage operations remain keyed by an opaque owner ID. Happy Agent's tools and command host use
 * one stable global owner for their shared installation catalog, while agent IDs identify the
 * scopes to which references are attached.
 *
 * Every mutation simply overwrites: calling `register`, `update`, `attach`, or `detach` again with
 * the same or a different value applies again and succeeds. There is no retry ledger.
 */
export class SecretsModule implements AgentModule {
    readonly name = "secrets";
    readonly migrations = secretsMigrations;

    readonly #store: SecretDatabase = createSecretDatabase();

    /** Subscribers taken after construction, inside and after the committing transaction. */
    readonly #transactionalListeners = new Set<SecretEventListener>();
    readonly #postCommitListeners = new Set<SecretEventListener>();

    /**
     * Watch the catalog inside the transaction that commits the change.
     *
     * A transactional subscriber runs before the commit, so throwing from one rejects the mutation
     * that produced the event. Returns the function that ends the subscription.
     */
    onEventTransactional(listener: SecretEventListener): SecretUnsubscribe {
        return this.#subscribe(this.#transactionalListeners, listener);
    }

    /**
     * Watch the catalog after the outermost transaction has committed.
     *
     * A post-commit subscriber cannot undo anything, so a failure in one is logged and the
     * remaining subscribers still see the event. Returns the function that ends the subscription.
     */
    onEvent(listener: SecretEventListener): SecretUnsubscribe {
        return this.#subscribe(this.#postCommitListeners, listener);
    }

    /** Return a bounded page of safe secret metadata, optionally filtered by an opaque scope. */
    async list(
        ctx: Context,
        actingAgentId: string,
        query: SecretListInput = {},
    ): Promise<SecretPage> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertInput(secretListInputSchema, query, "list query");
        const normalized = this.#listQuery(query);
        return await ctx.inTx(async (txCtx) => {
            const page = await this.#readPage(txCtx, actingAgentId, normalized);
            for (let count = page.secrets.length; count >= 1; count -= 1) {
                const candidate: SecretPage = {
                    secrets: page.secrets.slice(0, count),
                    limit: page.limit,
                    ...(count < page.secrets.length
                        ? { nextCursor: (normalized.cursor ?? 0) + count }
                        : page.nextCursor === undefined
                          ? {}
                          : { nextCursor: page.nextCursor }),
                };
                if (this.#formatPage(candidate, true).length <= SECRETS_OUTPUT_CHARACTERS) {
                    return candidate;
                }
            }
            if (page.secrets.length === 0) return page;
            throw new Error("Secret metadata cannot fit a complete model-facing page.");
        });
    }

    /** Read one safe reference. This method never returns registration values. */
    async reference(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
    ): Promise<SecretReference | undefined> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        const value = await this.#reference(ctx, actingAgentId, secretId);
        if (value === undefined) return undefined;
        const reference = this.#normalizeReference(value);
        if (reference.id !== secretId) {
            throw new Error("Secret store returned a different reference identity.");
        }
        return reference;
    }

    /** Register a host-owned secret and return safe metadata only. A repeated call overwrites. */
    async register(
        ctx: Context,
        actingAgentId: string,
        input: SecretRegistrationInput,
    ): Promise<SecretReference> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertInput(secretRegistrationInputSchema, input, "registration");
        const normalizedInput = normalizeRegistrationInput(input);

        return await this.#runTransaction(ctx, "register", async (txCtx) => {
            const id = normalizedInput.id ?? this.#newSecretId();
            const registration = this.#normalizeRegistration({ ...normalizedInput, id });
            const eventId = this.#newEventId();
            const at = this.#now();
            const before = await this.#reference(txCtx, actingAgentId, registration.id);
            const raw = await this.#store.register(
                txCtx,
                actingAgentId,
                structuredClone(registration),
            );
            const mutation = this.#asRegisterResult(raw);
            const authoritative = await this.#requiredReference(
                txCtx,
                actingAgentId,
                registration.id,
                "register",
            );
            const changed = this.#reconcileRegister(mutation, registration, authoritative, before);
            return {
                result: authoritative,
                event: changed
                    ? this.#event(
                          {
                              type: "secret_registered",
                              secret: authoritative,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Update host-owned values or description and return safe metadata only. A repeated call overwrites. */
    async update(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
        input: SecretUpdateInput,
    ): Promise<SecretReference | undefined> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        this.#assertInput(secretUpdateInputSchema, input, "update");
        const normalizedInput = normalizeUpdateInput(input);

        return await this.#runTransaction(ctx, "update", async (txCtx) => {
            const eventId = this.#newEventId();
            const at = this.#now();
            const before = await this.#reference(txCtx, actingAgentId, secretId);
            if (before === undefined) {
                const raw = await this.#store.update(
                    txCtx,
                    actingAgentId,
                    secretId,
                    structuredClone(normalizedInput),
                );
                const mutation = this.#asUpdateResult(raw, secretId);
                const after = await this.#reference(txCtx, actingAgentId, secretId);
                if (mutation.changed || mutation.reference !== undefined || after !== undefined) {
                    throw new Error("Secret update returned a mutation for a missing secret.");
                }
                return { result: undefined };
            }

            const raw = await this.#store.update(
                txCtx,
                actingAgentId,
                secretId,
                structuredClone(normalizedInput),
            );
            const mutation = this.#asUpdateResult(raw, secretId);
            const authoritative = await this.#requiredReference(
                txCtx,
                actingAgentId,
                secretId,
                "update",
            );
            const changed = this.#reconcileUpdate(
                mutation,
                before,
                authoritative,
                secretId,
                normalizedInput,
            );
            return {
                result: authoritative,
                event: changed
                    ? this.#event(
                          {
                              type: "secret_updated",
                              secret: authoritative,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Remove one secret and its attachments atomically in the module database. */
    async remove(ctx: Context, actingAgentId: string, secretId: string): Promise<boolean> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);

        return await this.#runTransaction(ctx, "remove", async (txCtx) => {
            const eventId = this.#newEventId();
            const at = this.#now();
            const before = await this.#reference(txCtx, actingAgentId, secretId);
            const raw = await this.#store.remove(txCtx, actingAgentId, secretId);
            const mutation = this.#asRemoveResult(raw, secretId);
            this.#reconcileRemove(mutation, before, secretId);
            const after = await this.#reference(txCtx, actingAgentId, secretId);
            if (before === undefined && after !== undefined) {
                throw new Error("Secret store remove created a missing secret.");
            }
            if (mutation.removed !== (before !== undefined && after === undefined)) {
                throw new Error("Secret store remove result is not authoritative.");
            }
            return {
                result: mutation.removed,
                event: mutation.removed
                    ? this.#event({ type: "secret_removed", secretId }, actingAgentId, eventId, at)
                    : undefined,
            };
        });
    }

    /** Attach one safe reference to an opaque host scope. */
    async attach(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
    ): Promise<SecretAttachment>;
    async attach(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
    ): Promise<SecretAttachment>;
    async attach(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId?: string,
    ): Promise<SecretAttachment> {
        const result = await this.#attachInternal(ctx, actingAgentId, scopeOrInput, secretId);
        return result.attachment;
    }

    /**
     * Attach one reference and retain the safe reference snapshot alongside the attachment. This is
     * what the durable tool calls so it can render both the attachment and the reference at once.
     */
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
    ): Promise<SecretAttachReferenceResult>;
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
    ): Promise<SecretAttachReferenceResult>;
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId?: string,
    ): Promise<SecretAttachReferenceResult> {
        return await this.#attachInternal(ctx, actingAgentId, scopeOrInput, secretId);
    }

    async #attachInternal(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId: string | undefined,
    ): Promise<SecretAttachReferenceResult> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        const input = this.#attachArguments(scopeOrInput, secretId);

        return await this.#runTransaction(ctx, "attach", async (txCtx) => {
            const eventId = this.#newEventId();
            const at = this.#now();
            const reference = await this.#reference(txCtx, actingAgentId, input.secretId);
            if (reference === undefined) {
                throw new Error("The secret reference does not exist.");
            }
            if (reference.availableToModel === false) {
                throw new Error(
                    `Secret '${input.secretId}' is managed by the host and cannot be attached to agent commands.`,
                );
            }
            const before = await this.#attachment(txCtx, actingAgentId, input);
            const raw = await this.#store.attach(txCtx, actingAgentId, structuredClone(input));
            const mutation = this.#asAttachResult(raw, input);
            const authoritative = await this.#requiredAttachment(
                txCtx,
                actingAgentId,
                input,
                "attach",
            );
            this.#reconcileAttach(mutation, before, authoritative, input, reference);
            const toolResult: SecretAttachReferenceResult = {
                attachment: structuredClone(authoritative),
                secret: structuredClone(reference),
            };
            if (!Value.Check(secretAttachReferenceResultSchema, toolResult)) {
                throw new Error("Secrets module created an invalid attach result.");
            }
            return {
                result: toolResult,
                event: mutation.changed
                    ? this.#event(
                          {
                              type: "secret_attached",
                              attachment: authoritative,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Detach one safe reference from an opaque host scope. */
    async detach(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
    ): Promise<boolean>;
    async detach(ctx: Context, actingAgentId: string, input: SecretAttachInput): Promise<boolean>;
    async detach(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId?: string,
    ): Promise<boolean> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        const input = this.#attachArguments(scopeOrInput, secretId);

        return await this.#runTransaction(ctx, "detach", async (txCtx) => {
            const eventId = this.#newEventId();
            const at = this.#now();
            const before = await this.#attachment(txCtx, actingAgentId, input);
            const raw = await this.#store.detach(txCtx, actingAgentId, structuredClone(input));
            const mutation = this.#asDetachResult(raw, input);
            const after = await this.#attachment(txCtx, actingAgentId, input);
            if (before === undefined && after !== undefined) {
                throw new Error("Secret store detach created a missing attachment.");
            }
            if (mutation.detached !== (before !== undefined && after === undefined)) {
                throw new Error("Secret store detach result is not authoritative.");
            }
            if (!mutation.detached && mutation.attachment !== undefined) {
                throw new Error("Secret store detach returned an attachment for a no-op.");
            }
            return {
                result: mutation.detached,
                event: mutation.detached
                    ? this.#event(
                          {
                              type: "secret_detached",
                              scopeRef: input.scopeRef,
                              secretId: input.secretId,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /**
     * Resolve attached values for a trusted host operation, out of the module's own catalog.
     *
     * This is deliberately not a tool and its result is never converted into model-facing text.
     */
    async resolveForHost(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretIds?: readonly string[],
    ): Promise<SecretHostEnvironment> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertScopeRef(scopeRef);
        const normalizedSecretIds = this.#normalizeSecretSelection(secretIds);
        if (normalizedSecretIds !== undefined) {
            await this.#assertSelectionAttached(ctx, actingAgentId, scopeRef, normalizedSecretIds);
        }
        const environment = await this.#store.resolveForHost(
            ctx,
            actingAgentId,
            scopeRef,
            normalizedSecretIds,
        );
        assertSecretHostEnvironment(environment);
        return structuredClone(environment);
    }

    /**
     * Resolve selected attachments for a command host, out of the module's own catalog. The
     * returned names must be removed from the command's ambient environment case-insensitively
     * before `environment` is added.
     */
    async resolveForCommand(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretIds?: readonly string[],
    ): Promise<SecretCommandEnvironment> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertScopeRef(scopeRef);
        const normalizedSecretIds = this.#normalizeSecretSelection(secretIds);

        return await ctx.inTx(async (txCtx) => {
            const selectedSecretIds = await this.#resolveCommandSecretIds(
                txCtx,
                actingAgentId,
                scopeRef,
                normalizedSecretIds,
            );
            const attachedNames = await this.#store.environmentVariableNamesForScope(
                txCtx,
                actingAgentId,
                scopeRef,
            );

            const environment: SecretHostEnvironment = await this.#store.resolveForHost(
                txCtx,
                actingAgentId,
                scopeRef,
                selectedSecretIds,
            );
            assertSecretHostEnvironment(environment);
            const result = {
                environment,
                hiddenEnvironmentVariables: mergeEnvironmentVariableNames(
                    attachedNames,
                    Object.keys(environment),
                ),
            };
            assertSecretCommandEnvironment(result);
            if (!Value.Check(secretCommandEnvironmentSchema, result)) {
                throw new Error("Secrets module created an invalid command environment.");
            }
            if (
                !Value.Check(
                    secretEnvironmentVariableNamesSchema,
                    result.hiddenEnvironmentVariables,
                )
            ) {
                throw new Error("Secrets module created invalid hidden environment names.");
            }
            return structuredClone(result);
        });
    }

    readonly #hooks: AgentModuleHooks = {
        /** Common provider-neutral tools over the installation-wide catalog. */
        tools: (_ctx: Context, _scope: AgentModuleScope): readonly AnyAgentTool[] => [
            listSecretsTool(this, GLOBAL_SECRET_OWNER_ID),
            referenceSecretTool(this, GLOBAL_SECRET_OWNER_ID),
            createSecretTool(this, GLOBAL_SECRET_OWNER_ID),
            updateSecretTool(this, GLOBAL_SECRET_OWNER_ID),
            attachSecretTool(this, GLOBAL_SECRET_OWNER_ID),
            detachSecretTool(this, GLOBAL_SECRET_OWNER_ID),
        ],

        /** Tell the model how safe references become one command's host-only environment. */
        instructions: async (_ctx: Context, scope: AgentModuleScope): Promise<string> =>
            [
                "Secret tools expose the shared installation catalog's references and environment-variable names only. Secret values are available only to the host and must never be requested in chat, tool arguments, or model output.",
                "Create or update a global secret from an absolute host .env path; the reviewed tool reads its values host-side and never returns them. Creating or updating does not attach the reference to an agent.",
                `This agent's shell-command attachment scope is ${JSON.stringify(scope.agent.id)}. Attach a model-available reference to that exact scope, then put only the secret IDs one shell command needs in its secrets argument. Omit secrets or use an empty array for none. Secret selection is reviewed but stays inside the current sandbox; requesting elevated permissions is a separate choice, and the two may be used independently or together.`,
            ].join(" "),
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /** Render safe metadata for a model without ever reading host values. */
    formatForModel(page: SecretPage): string {
        const normalized = this.#normalizePage(page);
        const output = this.#formatPage(normalized, false);
        if (output.length > SECRETS_OUTPUT_CHARACTERS) {
            throw new Error("Secret model output cannot fit complete metadata identities.");
        }
        return output;
    }

    /** Render a page and retain its opaque continuation cursor for the model. */
    formatPageForModel(page: SecretPage): string {
        const normalized = this.#normalizePage(page);
        const output = this.#formatPage(normalized, true);
        if (output.length > SECRETS_OUTPUT_CHARACTERS) {
            throw new Error("Secret page output cannot fit complete metadata and cursor.");
        }
        return output;
    }

    /** Format an attachment result without allowing tool-added context to exceed the cap. */
    formatAttachmentForModel(scopeRef: SecretScopeRef, secret: SecretReference): string {
        this.#assertScopeRef(scopeRef);
        const normalized = this.#normalizeReference(secret);
        const detailed = `Attached ${JSON.stringify(normalized.id)} to scope ${JSON.stringify(scopeRef)}.\n${this.#formatPage(
            {
                secrets: [normalized],
                limit: 1,
            },
            false,
        )}`;
        const output =
            detailed.length <= SECRETS_OUTPUT_CHARACTERS
                ? detailed
                : `attach\nscope=${scopeRef}\nsecret=${normalized.id}`;
        if (output.length > SECRETS_OUTPUT_CHARACTERS) {
            throw new Error("Secret attachment output cannot fit complete metadata.");
        }
        return output;
    }

    /** Format a detach result without allowing long opaque identities to bypass the cap. */
    formatDetachForModel(detached: boolean, scopeRef: SecretScopeRef, secretId: SecretId): string {
        this.#assertScopeRef(scopeRef);
        this.#assertSecretId(secretId);
        const detailed = detached
            ? `Detached ${JSON.stringify(secretId)} from scope ${JSON.stringify(scopeRef)}.`
            : `Secret ${JSON.stringify(secretId)} was not attached to scope ${JSON.stringify(scopeRef)}.`;
        const output =
            detailed.length <= SECRETS_OUTPUT_CHARACTERS
                ? detailed
                : detached
                  ? `detached\nscope=${scopeRef}\nsecret=${secretId}`
                  : `not attached\nscope=${scopeRef}\nsecret=${secretId}`;
        if (output.length > SECRETS_OUTPUT_CHARACTERS) {
            throw new Error("Secret detach output cannot fit complete identities.");
        }
        return output;
    }

    async #readPage(
        ctx: Context,
        actingAgentId: SecretAgentId,
        query: SecretListQuery,
    ): Promise<SecretPage> {
        const raw = await this.#store.list(ctx, actingAgentId, query);
        assertSecretPage(raw);
        if (raw.limit !== query.limit || raw.secrets.length > query.limit) {
            throw new Error("Secret store returned a page outside the requested bounds.");
        }
        if (raw.nextCursor !== undefined) {
            if (
                raw.secrets.length === 0 ||
                !cursorProgressed(query.cursor, raw.nextCursor, raw.secrets.length)
            ) {
                throw new Error("Secret store returned a non-progressing secret cursor.");
            }
        }
        const page = this.#normalizePage({
            secrets: raw.secrets,
            limit: query.limit,
            ...(raw.nextCursor === undefined ? {} : { nextCursor: raw.nextCursor }),
        });
        if (query.scopeRef !== undefined) {
            for (const secret of page.secrets) {
                const attachment = await this.#attachment(ctx, actingAgentId, {
                    scopeRef: query.scopeRef,
                    secretId: secret.id,
                });
                if (attachment === undefined) {
                    throw new Error(
                        "Secret store returned a reference that is not attached to the requested scope.",
                    );
                }
            }
        }
        return page;
    }

    #formatPage(page: SecretPage, includeCursor: boolean): string {
        const withCursor = (rows: string): string =>
            includeCursor && page.nextCursor !== undefined
                ? `${rows}\nnext=${page.nextCursor}`
                : rows;
        const detailedRows =
            page.secrets.length === 0
                ? "No secret references."
                : page.secrets.map((secret) => this.#formatReference(secret)).join("\n");
        const detailed = withCursor(detailedRows);
        if (detailed.length <= SECRETS_OUTPUT_CHARACTERS) return detailed;
        const compactRows =
            page.secrets.length === 0
                ? "No secret references."
                : page.secrets.map((secret) => `secret id=${secret.id}`).join("\n");
        return withCursor(compactRows);
    }

    async #runTransaction<Result>(
        ctx: Context,
        _operation: string,
        work: (txCtx: Context) => Promise<SecretChange<Result>>,
    ): Promise<Result> {
        return await ctx.inTx(async (txCtx) => {
            const change = await work(txCtx);
            if (change.event !== undefined) {
                await this.#observe(txCtx, change.event);
            }
            return structuredClone(change.result);
        });
    }

    #subscribe(
        listeners: Set<SecretEventListener>,
        listener: SecretEventListener,
    ): SecretUnsubscribe {
        if (!Value.Check(secretEventListenerSchema, listener)) {
            throw new Error("A secrets subscriber must be a function.");
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    async #observe(ctx: Context, event: SecretEvent): Promise<void> {
        if (!Value.Check(secretEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Secrets module created an invalid unfrozen event.");
        }
        // A snapshot, so subscribing or unsubscribing from inside a subscriber cannot change who
        // this event goes to.
        for (const listener of [...this.#transactionalListeners]) await listener(ctx, event);
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: SecretEvent): Promise<void> {
        for (const listener of [...this.#postCommitListeners]) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                // Nothing here can undo a catalog change the database has already committed, and
                // one failing subscriber must not hide the event from the rest.
                ctx.log.error(
                    { error, eventId: event.eventId, type: event.type },
                    "A secrets subscriber failed after the change was committed.",
                );
            }
        }
    }

    #asRegisterResult(value: unknown): SecretStoreRegisterResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "register") {
            throw new Error("Secret store register returned the wrong operation.");
        }
        return value;
    }

    #asUpdateResult(value: unknown, secretId: SecretId): SecretStoreUpdateResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "update" || value.secretId !== secretId) {
            throw new Error("Secret store update returned a different secret identity.");
        }
        return value;
    }

    #asRemoveResult(value: unknown, secretId: SecretId): SecretStoreRemoveResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "remove" || value.secretId !== secretId) {
            throw new Error("Secret store remove returned a different secret identity.");
        }
        return value;
    }

    #asAttachResult(value: unknown, input: SecretAttachInput): SecretStoreAttachResult {
        assertSecretStoreMutationResult(value);
        if (
            value.operation !== "attach" ||
            value.attachment.scopeRef !== input.scopeRef ||
            value.attachment.secretId !== input.secretId
        ) {
            throw new Error("Secret store attach returned a different attachment.");
        }
        return value;
    }

    #asDetachResult(value: unknown, input: SecretAttachInput): SecretStoreDetachResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "detach") {
            throw new Error("Secret store detach returned the wrong operation.");
        }
        if (
            value.attachment !== undefined &&
            (value.attachment.scopeRef !== input.scopeRef ||
                value.attachment.secretId !== input.secretId)
        ) {
            throw new Error("Secret store detach returned a different attachment.");
        }
        return value;
    }

    #reconcileRegister(
        mutation: SecretStoreRegisterResult,
        request: SecretRegistration,
        authoritative: SecretReference,
        before: SecretReference | undefined,
    ): boolean {
        if (mutation.reference.id !== request.id || authoritative.id !== request.id) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        if (
            authoritative.description !== request.description ||
            !sameEnvironmentNames(authoritative.environmentVariables, request.environment) ||
            authoritative.availableToModel !== request.availableToModel
        ) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        const mutationReference = this.#normalizeReference(mutation.reference);
        const changed = before === undefined || !sameReference(before, authoritative);
        if (mutation.changed !== changed || !sameReference(mutationReference, authoritative)) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        return changed;
    }

    #reconcileUpdate(
        mutation: SecretStoreUpdateResult,
        before: SecretReference,
        authoritative: SecretReference,
        secretId: SecretId,
        request: SecretUpdateInput,
    ): boolean {
        const expectedDescription = request.description ?? before.description;
        const expectedEnvironmentNames = applyEnvironmentPatch(
            before.environmentVariables,
            request.environment,
        );
        const expectedAvailableToModel = request.availableToModel ?? before.availableToModel;
        if (
            authoritative.description !== expectedDescription ||
            !sameStrings(authoritative.environmentVariables, expectedEnvironmentNames) ||
            authoritative.availableToModel !== expectedAvailableToModel
        ) {
            throw new Error("Secret store did not authoritatively persist the update.");
        }
        const mutationReference =
            mutation.reference === undefined
                ? undefined
                : this.#normalizeReference(mutation.reference);
        const changed = !sameReference(before, authoritative);
        if (
            mutationReference === undefined ||
            mutationReference.id !== secretId ||
            !sameReference(mutationReference, authoritative) ||
            mutation.changed !== changed
        ) {
            throw new Error("Secret store did not authoritatively persist the update.");
        }
        return changed;
    }

    #reconcileRemove(
        mutation: SecretStoreRemoveResult,
        before: SecretReference | undefined,
        secretId: SecretId,
    ): void {
        if (
            mutation.secretId !== secretId ||
            mutation.removed !== (before !== undefined) ||
            (mutation.reference !== undefined &&
                (before === undefined || !sameReference(mutation.reference, before)))
        ) {
            throw new Error("Secret store remove result is not authoritative.");
        }
    }

    #reconcileAttach(
        mutation: SecretStoreAttachResult,
        before: SecretAttachment | undefined,
        authoritative: SecretAttachment,
        input: SecretAttachInput,
        reference: SecretReference,
    ): void {
        if (
            mutation.attachment.scopeRef !== input.scopeRef ||
            mutation.attachment.secretId !== input.secretId ||
            !sameJson(mutation.attachment, authoritative) ||
            mutation.changed !== (before === undefined) ||
            (mutation.reference !== undefined &&
                !sameReference(this.#normalizeReference(mutation.reference), reference))
        ) {
            throw new Error("Secret store did not authoritatively persist the attachment.");
        }
    }

    async #requiredReference(
        ctx: Context,
        actingAgentId: SecretAgentId,
        secretId: SecretId,
        operation: string,
    ): Promise<SecretReference> {
        const current = await this.#reference(ctx, actingAgentId, secretId);
        if (current === undefined) {
            throw new Error(`Secret store ${operation} has no authoritative reference.`);
        }
        return current;
    }

    async #reference(
        ctx: Context,
        actingAgentId: SecretAgentId,
        secretId: SecretId,
    ): Promise<SecretReference | undefined> {
        const value = await this.#store.reference(ctx, actingAgentId, secretId);
        if (value === undefined) return undefined;
        const reference = this.#normalizeReference(value);
        if (reference.id !== secretId) {
            throw new Error("Secret store returned a different reference identity.");
        }
        return reference;
    }

    async #attachment(
        ctx: Context,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
    ): Promise<SecretAttachment | undefined> {
        const value = await this.#store.attachment(ctx, actingAgentId, input);
        if (value === undefined) return undefined;
        assertSecretAttachment(value);
        if (value.scopeRef !== input.scopeRef || value.secretId !== input.secretId) {
            throw new Error("Secret store returned a different attachment identity.");
        }
        return structuredClone(value);
    }

    async #requiredAttachment(
        ctx: Context,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
        operation: string,
    ): Promise<SecretAttachment> {
        const value = await this.#attachment(ctx, actingAgentId, input);
        if (value === undefined) {
            throw new Error(`Secret store ${operation} has no authoritative attachment.`);
        }
        return value;
    }

    #newSecretId(): SecretId {
        const value = globalThis.crypto.randomUUID();
        if (!Value.Check(secretIdSchema, value)) {
            throw new Error("Secrets minted an invalid secret identity.");
        }
        return value;
    }

    #newEventId(): string {
        const value = globalThis.crypto.randomUUID();
        if (!Value.Check(secretEventIdSchema, value)) {
            throw new Error("Secrets minted an invalid event identity.");
        }
        return value;
    }

    #event(
        payload:
            | {
                  readonly type: "secret_registered" | "secret_updated";
                  readonly secret: SecretReference;
              }
            | { readonly type: "secret_removed"; readonly secretId: SecretId }
            | {
                  readonly type: "secret_attached";
                  readonly attachment: SecretAttachment;
              }
            | {
                  readonly type: "secret_detached";
                  readonly scopeRef: SecretScopeRef;
                  readonly secretId: SecretId;
              },
        actingAgentId: SecretAgentId,
        eventId: string,
        at: number,
    ): SecretEvent {
        const event = {
            ...payload,
            eventId,
            at,
            agentId: actingAgentId,
        };
        if (!Value.Check(secretEventSchema, event)) {
            throw new Error("Secrets module created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    #normalizeRegistration(
        input: SecretRegistrationInput & { readonly id: SecretId },
    ): SecretRegistration {
        assertUserSecretId(input.id);
        const registration = {
            id: input.id,
            description: normalizeText(input.description),
            environment: normalizeEnvironment(input.environment),
            ...(input.availableToModel === undefined
                ? {}
                : { availableToModel: input.availableToModel }),
        };
        if (!Value.Check(secretRegistrationSchema, registration)) {
            throw new Error("Secret registration is invalid.");
        }
        return registration;
    }

    #normalizePage(value: SecretPage): SecretPage {
        assertSecretPage(value);
        if (value.limit > SECRETS_PAGE_SIZE || value.secrets.length > value.limit) {
            throw new Error("Secret page exceeds the configured metadata bound.");
        }
        const ids = new Set<string>();
        const secrets = value.secrets.map((secret) => {
            const normalized = this.#normalizeReference(secret);
            if (ids.has(normalized.id)) throw new Error("Secret page contains duplicate IDs.");
            ids.add(normalized.id);
            return normalized;
        });
        return {
            secrets,
            limit: value.limit,
            ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
        };
    }

    #normalizeReference(value: SecretReference): SecretReference {
        assertSecretReference(value);
        const names = [...value.environmentVariables];
        const normalizedNames = new Set<string>();
        for (const name of names) {
            const normalized = name.toUpperCase();
            if (normalizedNames.has(normalized)) {
                throw new Error("Secret metadata contains duplicate environment variable names.");
            }
            normalizedNames.add(normalized);
        }
        return {
            id: value.id,
            description: value.description,
            environmentVariables: names.sort((left, right) => left.localeCompare(right)),
            revision: value.revision,
            ...(value.availableToModel === undefined
                ? {}
                : { availableToModel: value.availableToModel }),
            ...(value.kind === undefined ? {} : { kind: value.kind }),
        };
    }

    #formatReference(secret: SecretReference): string {
        return [
            `${JSON.stringify(secret.id)}: ${secret.description}`,
            `  Environment variables: ${
                secret.environmentVariables.length === 0
                    ? "none"
                    : secret.environmentVariables.join(", ")
            }`,
            `  Revision: ${JSON.stringify(secret.revision)}`,
            ...(secret.availableToModel === false ? ["  Availability: host only"] : []),
        ].join("\n");
    }

    #listQuery(query: SecretListInput): SecretListQuery {
        const normalized = {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.scopeRef === undefined ? {} : { scopeRef: query.scopeRef }),
            limit: query.limit ?? SECRETS_PAGE_SIZE,
        };
        if (!Value.Check(secretListQuerySchema, normalized)) {
            throw new Error("Secret list query is invalid.");
        }
        if (normalized.limit > SECRETS_PAGE_SIZE) {
            throw new Error(`Secret page limit cannot exceed ${SECRETS_PAGE_SIZE}.`);
        }
        return normalized;
    }

    #normalizeSecretSelection(secretIds: readonly string[] | undefined): SecretId[] | undefined {
        if (secretIds === undefined) return undefined;
        if (
            !Array.isArray(secretIds) ||
            secretIds.length > MAX_SECRET_LIST_ITEMS ||
            new Set(secretIds).size !== secretIds.length ||
            secretIds.some((secretId) => !Value.Check(secretIdSchema, secretId))
        ) {
            throw new Error("Secret resolver selection is invalid.");
        }
        return structuredClone(secretIds) as SecretId[];
    }

    async #resolveCommandSecretIds(
        ctx: Context,
        actingAgentId: SecretAgentId,
        scopeRef: SecretScopeRef,
        requestedSecretIds: SecretId[] | undefined,
    ): Promise<SecretId[]> {
        const selectedSecretIds =
            requestedSecretIds === undefined
                ? [...(await this.#store.attachedSecretIdsForScope(ctx, actingAgentId, scopeRef))]
                : structuredClone(requestedSecretIds);
        await this.#assertSelectionAttached(ctx, actingAgentId, scopeRef, selectedSecretIds);
        for (const secretId of selectedSecretIds) {
            const reference = await this.#reference(ctx, actingAgentId, secretId);
            if (reference === undefined) {
                throw new Error("Secret command selection refers to a missing secret.");
            }
            if (reference.availableToModel === false) {
                throw new Error(`Secret '${secretId}' is not available to agent commands.`);
            }
        }
        return selectedSecretIds;
    }

    async #assertSelectionAttached(
        ctx: Context,
        actingAgentId: SecretAgentId,
        scopeRef: SecretScopeRef,
        secretIds: readonly SecretId[],
    ): Promise<void> {
        for (const secretId of secretIds) {
            if (
                (await this.#attachment(ctx, actingAgentId, {
                    scopeRef,
                    secretId,
                })) === undefined
            ) {
                throw new Error(`Secret '${secretId}' is not attached to scope '${scopeRef}'.`);
            }
        }
    }

    #attachArguments(
        scopeOrInput: string | SecretAttachInput,
        secretId: string | undefined,
    ): SecretAttachInput {
        if (typeof scopeOrInput === "string") {
            if (typeof secretId !== "string") {
                throw new Error("Secret attachment input is invalid.");
            }
            const input = { scopeRef: scopeOrInput, secretId };
            if (!Value.Check(secretAttachInputSchema, input)) {
                throw new Error("Secret attachment input is invalid.");
            }
            return input;
        }
        if (!Value.Check(secretAttachInputSchema, scopeOrInput)) {
            throw new Error("Secret attachment input is invalid.");
        }
        return { scopeRef: scopeOrInput.scopeRef, secretId: scopeOrInput.secretId };
    }

    #assertContext(value: unknown): asserts value is Context {
        if (!Value.Check(secretContextSchema, value)) {
            throw new Error("Secret context is invalid.");
        }
    }

    #assertAgentId(value: unknown): asserts value is SecretAgentId {
        if (!Value.Check(secretAgentIdSchema, value)) {
            throw new Error("Secret acting agent ID is invalid.");
        }
    }

    #assertSecretId(value: unknown): asserts value is SecretId {
        if (!Value.Check(secretIdSchema, value)) {
            throw new Error("Secret ID is invalid.");
        }
    }

    #assertScopeRef(value: unknown): asserts value is SecretScopeRef {
        if (!Value.Check(secretScopeRefSchema, value)) {
            throw new Error("Secret scope reference is invalid.");
        }
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) {
            throw new Error(`Secret ${label} input is invalid.`);
        }
    }

    #now(): number {
        const at = Date.now();
        if (!Value.Check(secretEventTimestampSchema, at)) {
            throw new Error("The clock returned a time secrets cannot represent.");
        }
        return at;
    }
}

function assertUserSecretId(value: SecretId): void {
    const normalized = value.toLowerCase();
    if (!Value.Check(secretReservedIdSchema, normalized)) return;
    if (normalized === GITHUB_SECRET_ID) {
        throw new Error("Secret ID 'github' is reserved for GitHub CLI credentials.");
    }
    if (normalized === PROJECT_GIT_SECRET_ID) {
        throw new Error("Secret ID 'project-git' is reserved for managed project Git access.");
    }
}

function normalizeRegistrationInput(input: SecretRegistrationInput): SecretRegistrationInput {
    const normalized = {
        ...(input.id === undefined ? {} : { id: input.id }),
        description: normalizeText(input.description),
        environment: normalizeEnvironment(input.environment),
        ...(input.availableToModel === undefined
            ? {}
            : { availableToModel: input.availableToModel }),
    };
    if (!Value.Check(secretRegistrationInputSchema, normalized)) {
        throw new Error("Secret registration input is invalid after normalization.");
    }
    return normalized;
}

function normalizeUpdateInput(input: SecretUpdateInput): SecretUpdateInput {
    const normalized = {
        ...(input.description === undefined
            ? {}
            : { description: normalizeText(input.description) }),
        ...(input.environment === undefined
            ? {}
            : { environment: normalizeEnvironmentPatch(input.environment) }),
        ...(input.availableToModel === undefined
            ? {}
            : { availableToModel: input.availableToModel }),
    };
    if (!Value.Check(secretUpdateInputSchema, normalized)) {
        throw new Error("Secret update input is invalid after normalization.");
    }
    return normalized;
}

function normalizeEnvironment(
    environment: SecretRegistration["environment"],
): SecretRegistration["environment"] {
    const result = Object.create(null) as Record<string, string>;
    const names = new Set<string>();
    for (const [name, value] of Object.entries(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secret registration contains duplicate environment variable names.");
        }
        names.add(normalized);
        Object.defineProperty(result, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return result;
}

function normalizeEnvironmentPatch(
    environment: NonNullable<SecretUpdateInput["environment"]>,
): NonNullable<SecretUpdateInput["environment"]> {
    const result = Object.create(null) as Record<string, string | null>;
    const names = new Set<string>();
    for (const [name, value] of Object.entries(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secret update contains duplicate environment variable names.");
        }
        names.add(normalized);
        Object.defineProperty(result, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return result;
}

function normalizeText(value: string): string {
    const normalized = value.trim();
    if (!Value.Check(Type.String({ minLength: 1, maxLength: 2_000 }), normalized)) {
        throw new Error("Secret description is invalid after normalization.");
    }
    return normalized;
}

function sameReference(left: SecretReference, right: SecretReference): boolean {
    return (
        left.id === right.id &&
        left.description === right.description &&
        sameStrings(left.environmentVariables, right.environmentVariables) &&
        left.revision === right.revision &&
        left.availableToModel === right.availableToModel &&
        left.kind === right.kind
    );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameEnvironmentNames(
    referenceNames: readonly string[],
    environment: Record<string, string>,
): boolean {
    return sameStrings(referenceNames, sortEnvironmentNames(Object.keys(environment)));
}

function applyEnvironmentPatch(
    before: readonly string[],
    patch: SecretUpdateInput["environment"],
): readonly string[] {
    // Kept by the comparison a process environment makes, so a patch naming an existing variable
    // in another case changes that variable and keeps its stored spelling instead of adding a
    // second variable that only some machines would tell apart.
    const names = new Map<string, string>();
    for (const name of before) names.set(name.toUpperCase(), name);
    if (patch !== undefined) {
        for (const [name, value] of Object.entries(patch)) {
            const normalized = name.toUpperCase();
            if (value === null) names.delete(normalized);
            else if (!names.has(normalized)) names.set(normalized, name);
        }
    }
    return sortEnvironmentNames([...names.values()]);
}

function sortEnvironmentNames(names: readonly string[]): string[] {
    return [...names].sort((left, right) => left.localeCompare(right));
}

function mergeEnvironmentVariableNames(...nameLists: readonly (readonly string[])[]): string[] {
    const names = new Map<string, string>();
    for (const nameList of nameLists) {
        for (const name of nameList) {
            const normalized = name.toUpperCase();
            if (!names.has(normalized)) names.set(normalized, name);
        }
    }
    return sortEnvironmentNames([...names.values()]);
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonicalize(left, 0)) === JSON.stringify(canonicalize(right, 0));
}

function canonicalize(value: unknown, depth: number): unknown {
    if (depth > 32) {
        throw new Error("Secret structured comparison exceeds its nesting depth bound.");
    }
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item, depth + 1));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonicalize(item, depth + 1)]),
        );
    }
    return value;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function isDeepFrozen(value: unknown): boolean {
    if (value !== null && typeof value === "object") {
        if (!Object.isFrozen(value)) return false;
        return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
    }
    return true;
}

function cursorProgressed(
    requested: number | undefined,
    next: number,
    visibleCount: number,
): boolean {
    const current = requested ?? 0;
    const expected = current + visibleCount;
    return Number.isSafeInteger(expected) && next === expected;
}
