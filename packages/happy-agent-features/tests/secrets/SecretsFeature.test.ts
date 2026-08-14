import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    assertSecretAuthorization as exportedAssertSecretAuthorization,
    assertSecretMutationProof as exportedAssertSecretMutationProof,
    secretContextSchema as exportedSecretContextSchema,
    secretAttachReferenceResultSchema as exportedSecretAttachReferenceResultSchema,
    secretAttachProofSchema as exportedSecretAttachProofSchema,
    secretDetachInputSchema as exportedSecretDetachInputSchema,
    secretHostEnvironmentSchema as exportedSecretHostEnvironmentSchema,
    secretListInputSchema as exportedSecretListInputSchema,
    secretMutationProofSchema as exportedSecretMutationProofSchema,
    secretMutationOperationSchema as exportedSecretMutationOperationSchema,
    secretMutationOptionsSchema as exportedSecretMutationOptionsSchema,
    secretPageSchema as exportedSecretPageSchema,
    secretRevisionSchema as exportedSecretRevisionSchema,
    type SecretAttachReferenceResult as ExportedSecretAttachReferenceResult,
    type SecretDetachInput as ExportedSecretDetachInput,
    type SecretHostEnvironment as ExportedSecretHostEnvironment,
    type SecretListInput as ExportedSecretListInput,
    type SecretMutationOperation as ExportedSecretMutationOperation,
    type SecretMutationOptions as ExportedSecretMutationOptions,
    type SecretPage as ExportedSecretPage,
} from "../../sources/index.js";
import {
    secretDetachInputSchema,
    secretAttachReferenceResultSchema,
    secretListInputSchema,
    secretPageSchema,
    secretRevisionSchema,
    type SecretAttachment,
    type SecretAttachInput,
    type SecretListInput,
    type SecretListQuery,
    type SecretMutationOptions,
    type SecretReference,
    type SecretRegistration,
    type SecretRegistrationInput,
    type SecretRevision,
    type SecretUpdateInput,
} from "../../sources/secrets/Secret.js";
import {
    secretOperationReceiptSchema,
    type SecretMutationRequest,
    type SecretMutationProof,
    type SecretOperationReceipt,
    type SecretStore,
} from "../../sources/secrets/SecretStore.js";
import type { SecretEvent } from "../../sources/secrets/SecretEvent.js";
import { SecretsFeature } from "../../sources/secrets/SecretsFeature.js";

const root = createRootContext().named("secrets-feature-test");
const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";

type StoredSecret = SecretRegistration & {
    readonly ownerAgentId: string;
    readonly revision: SecretRevision;
};

class MemorySecretStore {
    readonly records = new Map<string, StoredSecret>();
    readonly attachments = new Map<string, Set<string>>();
    readonly receipts = new Map<string, SecretOperationReceipt>();
    readonly proofs = new Map<string, SecretMutationProof>();
    readonly calls: Array<{ method: string; agentId: string }> = [];
    readonly transactionalEvents: SecretEvent[] = [];
    readonly postCommitEvents: SecretEvent[] = [];
    readonly postCommitContexts: Context[] = [];
    readonly callbacks: Array<(postCommitCtx: Context) => void | Promise<unknown>> = [];
    readonly postCommitCtx = createRootContext().named("secrets-post-commit");
    readonly contract: SecretStore = {
        transaction: this.transaction.bind(this),
        afterCommit: this.afterCommit.bind(this),
        list: this.list.bind(this),
        reference: this.reference.bind(this),
        attachment: this.attachment.bind(this),
        register: this.register.bind(this),
        update: this.update.bind(this),
        remove: this.remove.bind(this),
        attach: this.attach.bind(this),
        detach: this.detach.bind(this),
        readReceipt: this.readReceipt.bind(this),
        writeReceipt: this.writeReceipt.bind(this),
        readMutationProof: this.readMutationProof.bind(this),
        writeMutationProof: this.writeMutationProof.bind(this),
        resolveForHost: this.resolveForHost.bind(this),
    };
    failTransactionalListener = false;
    returnSubstitutedTransaction = false;
    corruptRegisterResult = false;
    #depth = 0;
    #snapshot:
        | {
              readonly records: Map<string, StoredSecret>;
              readonly attachments: Map<string, Set<string>>;
              readonly receipts: Map<string, SecretOperationReceipt>;
              readonly proofs: Map<string, SecretMutationProof>;
          }
        | undefined;

    async transaction<Result>(
        _ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        const outermost = this.#depth === 0;
        if (outermost) {
            this.#snapshot = {
                records: cloneMap(this.records),
                attachments: cloneAttachments(this.attachments),
                receipts: cloneReceipts(this.receipts),
                proofs: cloneProofs(this.proofs),
            };
        }
        this.#depth += 1;
        try {
            const result = await work(root);
            this.#depth -= 1;
            if (outermost) {
                this.#snapshot = undefined;
                while (this.callbacks.length > 0) {
                    await this.callbacks.shift()!(this.postCommitCtx);
                }
            }
            return this.returnSubstitutedTransaction
                ? (structuredClone({ result: "substituted" }) as Result)
                : result;
        } catch (error: unknown) {
            this.#depth -= 1;
            if (outermost) {
                this.restoreSnapshot();
                this.callbacks.length = 0;
                this.#snapshot = undefined;
            }
            throw error;
        }
    }

    afterCommit(
        _ctx: Context,
        callback: (postCommitCtx: Context) => void | Promise<unknown>,
    ): void {
        if (this.#depth === 0) throw new Error("afterCommit must be called inside a transaction");
        this.callbacks.push(callback);
    }

    async list(_ctx: Context, agentId: string, query: SecretListQuery) {
        this.calls.push({ method: "list", agentId });
        const ids = [...this.records.entries()]
            .filter(([, record]) => record.ownerAgentId === agentId)
            .filter(([id]) => {
                if (query.scopeRef === undefined) return true;
                return (
                    this.attachments.get(attachmentKey(agentId, query.scopeRef))?.has(id) === true
                );
            })
            .map(([id]) => id)
            .sort();
        const start = query.cursor ?? 0;
        if (!Number.isInteger(start) || start < 0) throw new Error("bad cursor");
        const selected = ids.slice(start, start + query.limit);
        const page = {
            secrets: selected.map((id) => this.referenceValue(this.records.get(id)!)),
            limit: query.limit,
            ...(start + selected.length < ids.length
                ? { nextCursor: start + selected.length }
                : {}),
        };
        if (!Value.Check(secretPageSchema, page)) throw new Error("invalid test page");
        return page;
    }

    async reference(
        _ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SecretReference | undefined> {
        this.calls.push({ method: "reference", agentId });
        const record = this.records.get(id);
        return record?.ownerAgentId === agentId ? this.referenceValue(record) : undefined;
    }

    async attachment(
        _ctx: Context,
        agentId: string,
        input: { readonly scopeRef: string; readonly secretId: string },
    ): Promise<SecretAttachment | undefined> {
        this.calls.push({ method: "attachment", agentId });
        return this.attachments.get(attachmentKey(agentId, input.scopeRef))?.has(input.secretId)
            ? structuredClone(input)
            : undefined;
    }

    async register(
        _ctx: Context,
        agentId: string,
        registration: SecretRegistration,
        operation: SecretMutationRequest,
    ) {
        this.calls.push({ method: "register", agentId });
        const existing = this.records.get(registration.id);
        if (existing !== undefined && existing.ownerAgentId !== agentId) {
            throw new Error("secret is owned by another agent");
        }
        const valuesChanged =
            existing !== undefined &&
            JSON.stringify(existing.environment) !== JSON.stringify(registration.environment);
        const changed =
            existing === undefined ||
            existing.description !== registration.description ||
            valuesChanged;
        this.records.set(registration.id, {
            ...structuredClone(registration),
            ownerAgentId: agentId,
            revision:
                existing === undefined
                    ? "1"
                    : valuesChanged
                      ? advanceRevision(existing.revision)
                      : existing.revision,
        });
        const result = {
            operation: "register" as const,
            ...operation,
            changed,
            reference: this.referenceValue(this.records.get(registration.id)!),
        };
        if (this.corruptRegisterResult) {
            return { ...result, reference: { ...result.reference, id: "wrong" } };
        }
        return result;
    }

    async update(
        _ctx: Context,
        agentId: string,
        id: string,
        input: SecretUpdateInput,
        operation: SecretMutationRequest,
    ) {
        this.calls.push({ method: "update", agentId });
        const existing = this.records.get(id);
        if (existing === undefined || existing.ownerAgentId !== agentId) {
            return {
                operation: "update" as const,
                ...operation,
                changed: false,
                secretId: id,
            };
        }
        const environment = { ...existing.environment };
        for (const [name, value] of Object.entries(input.environment ?? {})) {
            if (value === null) delete environment[name];
            else defineEnvironmentValue(environment, name, value);
        }
        const next = {
            ...existing,
            ...(input.description === undefined ? {} : { description: input.description }),
            environment,
            revision:
                JSON.stringify(existing.environment) !== JSON.stringify(environment)
                    ? advanceRevision(existing.revision)
                    : existing.revision,
        };
        const changed =
            existing.description !== next.description ||
            JSON.stringify(existing.environment) !== JSON.stringify(next.environment);
        this.records.set(id, next);
        return {
            operation: "update" as const,
            ...operation,
            changed,
            secretId: id,
            reference: this.referenceValue(next),
        };
    }

    async remove(_ctx: Context, agentId: string, id: string, operation: SecretMutationRequest) {
        this.calls.push({ method: "remove", agentId });
        const existing = this.records.get(id);
        if (existing === undefined || existing.ownerAgentId !== agentId) {
            return {
                operation: "remove" as const,
                ...operation,
                removed: false,
                secretId: id,
            };
        }
        this.records.delete(id);
        for (const [key, ids] of this.attachments) {
            if (key.startsWith(`${agentId}\u0000`)) ids.delete(id);
        }
        return {
            operation: "remove" as const,
            ...operation,
            removed: true,
            secretId: id,
            reference: this.referenceValue(existing),
        };
    }

    async attach(
        _ctx: Context,
        agentId: string,
        input: { readonly scopeRef: string; readonly secretId: string },
        operation: SecretMutationRequest,
    ) {
        this.calls.push({ method: "attach", agentId });
        const record = this.records.get(input.secretId);
        if (record?.ownerAgentId !== agentId) throw new Error("secret is not available");
        const key = attachmentKey(agentId, input.scopeRef);
        const ids = this.attachments.get(key) ?? new Set<string>();
        const changed = !ids.has(input.secretId);
        ids.add(input.secretId);
        this.attachments.set(key, ids);
        return {
            operation: "attach" as const,
            ...operation,
            changed,
            attachment: structuredClone(input),
            reference: this.referenceValue(record),
        };
    }

    async detach(
        _ctx: Context,
        agentId: string,
        input: { readonly scopeRef: string; readonly secretId: string },
        operation: SecretMutationRequest,
    ) {
        this.calls.push({ method: "detach", agentId });
        const ids = this.attachments.get(attachmentKey(agentId, input.scopeRef));
        const detached = ids?.delete(input.secretId) ?? false;
        return {
            operation: "detach" as const,
            ...operation,
            detached,
            ...(detached ? { attachment: structuredClone(input) } : {}),
        };
    }

    async readReceipt(_ctx: Context, agentId: string, operationId: string) {
        this.calls.push({ method: "readReceipt", agentId });
        return cloneReceipt(this.receipts.get(receiptKey(agentId, operationId)));
    }

    async writeReceipt(
        _ctx: Context,
        agentId: string,
        receipt: SecretOperationReceipt,
    ): Promise<void> {
        this.calls.push({ method: "writeReceipt", agentId });
        if (receipt.agentId !== agentId) throw new Error("receipt owner mismatch");
        this.receipts.set(receiptKey(agentId, receipt.operationId), structuredClone(receipt));
    }

    async readMutationProof(_ctx: Context, agentId: string, operationId: string) {
        this.calls.push({ method: "readMutationProof", agentId });
        return cloneProof(this.proofs.get(receiptKey(agentId, operationId)));
    }

    async writeMutationProof(
        _ctx: Context,
        agentId: string,
        proof: SecretMutationProof,
    ): Promise<void> {
        this.calls.push({ method: "writeMutationProof", agentId });
        if (proof.agentId !== agentId) throw new Error("proof owner mismatch");
        const key = receiptKey(agentId, proof.operationId);
        const existing = this.proofs.get(key);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(proof)) {
            throw new Error("immutable proof was rewritten");
        }
        this.proofs.set(key, structuredClone(proof));
    }

    async resolveForHost(
        _ctx: Context,
        agentId: string,
        scopeRef: string,
        secretIds?: readonly string[],
    ): Promise<Record<string, string>> {
        this.calls.push({ method: "resolveForHost", agentId });
        const attached =
            this.attachments.get(attachmentKey(agentId, scopeRef)) ?? new Set<string>();
        const selected = secretIds ?? [...attached];
        const result: Record<string, string> = {};
        for (const id of selected) {
            if (!attached.has(id)) continue;
            const record = this.records.get(id);
            if (record?.ownerAgentId === agentId) {
                for (const [name, value] of Object.entries(record.environment)) {
                    defineEnvironmentValue(result, name, value);
                }
            }
        }
        return result;
    }

    private restoreSnapshot(): void {
        this.records.clear();
        for (const [id, record] of this.#snapshot?.records ?? []) {
            this.records.set(id, record);
        }
        this.attachments.clear();
        for (const [key, ids] of this.#snapshot?.attachments ?? []) {
            this.attachments.set(key, new Set(ids));
        }
        this.receipts.clear();
        for (const [key, receipt] of this.#snapshot?.receipts ?? []) {
            this.receipts.set(key, receipt);
        }
        this.proofs.clear();
        for (const [key, proof] of this.#snapshot?.proofs ?? []) {
            this.proofs.set(key, proof);
        }
    }

    private referenceValue(record: StoredSecret): SecretReference {
        return {
            id: record.id,
            description: record.description,
            environmentVariables: Object.keys(record.environment).sort(),
            revision: record.revision,
        };
    }
}

class ClassBackedSecretStore implements SecretStore {
    readonly #delegate = new MemorySecretStore();

    transaction(
        ...args: Parameters<SecretStore["transaction"]>
    ): ReturnType<SecretStore["transaction"]> {
        return this.#delegate.contract.transaction(...args);
    }

    afterCommit(
        ...args: Parameters<SecretStore["afterCommit"]>
    ): ReturnType<SecretStore["afterCommit"]> {
        return this.#delegate.contract.afterCommit(...args);
    }

    list(...args: Parameters<SecretStore["list"]>): ReturnType<SecretStore["list"]> {
        return this.#delegate.contract.list(...args);
    }

    reference(...args: Parameters<SecretStore["reference"]>): ReturnType<SecretStore["reference"]> {
        return this.#delegate.contract.reference(...args);
    }

    attachment(
        ...args: Parameters<SecretStore["attachment"]>
    ): ReturnType<SecretStore["attachment"]> {
        return this.#delegate.contract.attachment(...args);
    }

    register(...args: Parameters<SecretStore["register"]>): ReturnType<SecretStore["register"]> {
        return this.#delegate.contract.register(...args);
    }

    update(...args: Parameters<SecretStore["update"]>): ReturnType<SecretStore["update"]> {
        return this.#delegate.contract.update(...args);
    }

    remove(...args: Parameters<SecretStore["remove"]>): ReturnType<SecretStore["remove"]> {
        return this.#delegate.contract.remove(...args);
    }

    attach(...args: Parameters<SecretStore["attach"]>): ReturnType<SecretStore["attach"]> {
        return this.#delegate.contract.attach(...args);
    }

    detach(...args: Parameters<SecretStore["detach"]>): ReturnType<SecretStore["detach"]> {
        return this.#delegate.contract.detach(...args);
    }

    readReceipt(
        ...args: Parameters<SecretStore["readReceipt"]>
    ): ReturnType<SecretStore["readReceipt"]> {
        return this.#delegate.contract.readReceipt(...args);
    }

    writeReceipt(
        ...args: Parameters<SecretStore["writeReceipt"]>
    ): ReturnType<SecretStore["writeReceipt"]> {
        return this.#delegate.contract.writeReceipt(...args);
    }

    readMutationProof(
        ...args: Parameters<SecretStore["readMutationProof"]>
    ): ReturnType<SecretStore["readMutationProof"]> {
        return this.#delegate.contract.readMutationProof(...args);
    }

    writeMutationProof(
        ...args: Parameters<SecretStore["writeMutationProof"]>
    ): ReturnType<SecretStore["writeMutationProof"]> {
        return this.#delegate.contract.writeMutationProof(...args);
    }

    resolveForHost(
        ...args: Parameters<SecretStore["resolveForHost"]>
    ): ReturnType<SecretStore["resolveForHost"]> {
        return this.#delegate.contract.resolveForHost(...args);
    }
}

function attachmentKey(agentId: string, scopeRef: string): string {
    return `${agentId}\u0000${scopeRef}`;
}

function receiptKey(agentId: string, operationId: string): string {
    return `${agentId}\u0000${operationId}`;
}

function cloneMap(source: Map<string, StoredSecret>): Map<string, StoredSecret> {
    return new Map([...source.entries()].map(([id, record]) => [id, structuredClone(record)]));
}

function cloneAttachments(source: Map<string, Set<string>>): Map<string, Set<string>> {
    return new Map([...source.entries()].map(([scope, ids]) => [scope, new Set(ids)]));
}

function cloneReceipts(
    source: Map<string, SecretOperationReceipt>,
): Map<string, SecretOperationReceipt> {
    return new Map([...source.entries()].map(([key, receipt]) => [key, structuredClone(receipt)]));
}

function cloneProofs(source: Map<string, SecretMutationProof>): Map<string, SecretMutationProof> {
    return new Map([...source.entries()].map(([key, proof]) => [key, structuredClone(proof)]));
}

function cloneReceipt(
    receipt: SecretOperationReceipt | undefined,
): SecretOperationReceipt | undefined {
    return receipt === undefined ? undefined : structuredClone(receipt);
}

function cloneProof(proof: SecretMutationProof | undefined): SecretMutationProof | undefined {
    return proof === undefined ? undefined : structuredClone(proof);
}

function defineEnvironmentValue(
    environment: Record<string, string>,
    name: string,
    value: string,
): void {
    Object.defineProperty(environment, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}

function advanceRevision(revision: SecretRevision): SecretRevision {
    const next = Number(revision) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("test revision exhausted");
    return String(next);
}

function feature(
    store: MemorySecretStore,
    overrides: Partial<ConstructorParameters<typeof SecretsFeature>[0]> = {},
): SecretsFeature {
    let id = 0;
    let mutation = 0;
    let event = 0;
    return new SecretsFeature({
        store: store.contract,
        idFactory: () => `secret-${++id}`,
        mutationIdFactory: () => `operation-${++mutation}`,
        eventIdFactory: () => `event-${++event}`,
        clock: () => 100 + event,
        listener: {
            onEventTransactional: (_ctx, value) => {
                store.transactionalEvents.push(value);
            },
            onEvent: (_ctx, value) => {
                store.postCommitEvents.push(value);
                store.postCommitContexts.push(_ctx);
            },
        },
        ...overrides,
    });
}

function callCtx(): Context {
    const persistence = new DurableValues();
    return withAgentKV(root, new AgentKV(persistence, "secret-call."));
}

describe("SecretsFeature", () => {
    it("exports the complete public schema and type surface from the package root", () => {
        const publicTypes:
            | {
                  detach: ExportedSecretDetachInput;
                  attachResult: ExportedSecretAttachReferenceResult;
                  environment: ExportedSecretHostEnvironment;
                  list: ExportedSecretListInput;
                  operation: ExportedSecretMutationOperation;
                  options: ExportedSecretMutationOptions;
                  page: ExportedSecretPage;
              }
            | undefined = undefined;
        void publicTypes;

        expect(exportedSecretDetachInputSchema).toBe(secretDetachInputSchema);
        expect(exportedSecretAttachReferenceResultSchema).toBe(secretAttachReferenceResultSchema);
        expect(
            Value.Check(exportedSecretAttachProofSchema, {
                agentId: AGENT,
                operation: "attach",
                operationId: "proof",
                fingerprint: "v1-proof",
                scopeRef: "scope",
                secretId: "secret",
                changed: true,
                attachment: {
                    scopeRef: "scope",
                    secretId: "secret",
                },
                reference: {
                    id: "secret",
                    description: "Secret",
                    environmentVariables: ["TOKEN"],
                    revision: "1",
                },
            }),
        ).toBe(true);
        expect(exportedSecretRevisionSchema).toBe(secretRevisionSchema);
        expect(Value.Check(exportedSecretRevisionSchema, "revision-1")).toBe(true);
        expect(exportedSecretListInputSchema).toBe(secretListInputSchema);
        expect(Value.Check(exportedSecretListInputSchema, {})).toBe(true);
        expect(
            Value.Check(exportedSecretListInputSchema, {
                unexpected: true,
            }),
        ).toBe(false);
        expect(Value.Check(exportedSecretHostEnvironmentSchema, { TOKEN: "value" })).toBe(true);
        expect(Value.Check(exportedSecretMutationOperationSchema, "update")).toBe(true);
        expect(Value.Check(exportedSecretMutationOptionsSchema, {})).toBe(true);
        expect(
            Value.Check(exportedSecretMutationProofSchema, {
                agentId: AGENT,
                operation: "remove",
                operationId: "proof",
                fingerprint: "v1-proof",
                secretId: "secret",
                before: null,
                removed: false,
            }),
        ).toBe(true);
        expect(() =>
            exportedAssertSecretMutationProof({
                agentId: AGENT,
                operation: "remove",
                operationId: "proof",
                fingerprint: "v1-proof",
                secretId: "secret",
                before: null,
                removed: false,
            }),
        ).not.toThrow();
        expect(
            Value.Check(exportedSecretPageSchema, {
                secrets: [],
                limit: 1,
            }),
        ).toBe(true);
        expect(Value.Check(exportedSecretContextSchema, root)).toBe(true);
        expect(() => exportedAssertSecretAuthorization(() => true)).not.toThrow();
    });

    it("keeps raw values host-only and threads the acting identity through opaque scopes", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const created = await secrets.register(root, AGENT, {
            description: " deploy token ",
            environment: { DEPLOY_TOKEN: "super-secret" },
        });

        expect(created).toEqual({
            id: "secret-1",
            description: "deploy token",
            environmentVariables: ["DEPLOY_TOKEN"],
            revision: "1",
        });
        expect(secrets.formatForModel({ secrets: [created], limit: 1 })).not.toContain(
            "super-secret",
        );
        await secrets.attach(root, AGENT, "opaque-scope", created.id);
        expect(await secrets.resolveForHost(root, AGENT, "opaque-scope")).toEqual({
            DEPLOY_TOKEN: "super-secret",
        });
        expect(await secrets.reference(root, OTHER_AGENT, created.id)).toBeUndefined();
        expect(store.calls.filter((call) => call.agentId === AGENT).length).toBeGreaterThan(0);
        expect(store.calls.some((call) => call.agentId === OTHER_AGENT)).toBe(true);

        const scope = { agent: { id: AGENT } } as Parameters<SecretsFeature["tools"]>[1];
        const listTool = secrets.tools(root, scope)[0]!;
        const page = await listTool.execute(root, { limit: 10 });
        expect((await listTool.toLLM(page))[0]).not.toHaveProperty(
            "text",
            expect.stringContaining("super-secret"),
        );
        expect(secrets.tools(root, scope).some((tool) => tool.name === "resolve_for_host")).toBe(
            false,
        );
    });

    it("uses durable receipts and returns authoritative state on replay", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const options: SecretMutationOptions = { operationId: "register-op" };
        const first = await secrets.register(
            root,
            AGENT,
            {
                id: "token",
                description: "Token",
                environment: { TOKEN: "value" },
            },
            options,
        );
        const registerCalls = store.calls.filter((call) => call.method === "register").length;
        const second = await secrets.register(
            root,
            AGENT,
            {
                id: "token",
                description: "Token",
                environment: { TOKEN: "value" },
            },
            options,
        );
        expect(second).toEqual(first);
        expect(store.calls.filter((call) => call.method === "register")).toHaveLength(
            registerCalls,
        );
        const receipt = [...store.receipts.values()][0]!;
        expect(Value.Check(secretOperationReceiptSchema, receipt)).toBe(true);
        expect(JSON.stringify(receipt)).not.toContain("value");

        await secrets.update(
            root,
            AGENT,
            "token",
            { description: "Changed" },
            {
                operationId: "update-op",
            },
        );
        expect(
            await secrets.update(
                root,
                AGENT,
                "token",
                { description: "Changed" },
                { operationId: "update-op" },
            ),
        ).toEqual({
            id: "token",
            description: "Changed",
            environmentVariables: ["TOKEN"],
            revision: "1",
        });
    });

    it("reconciles value-only changes through a safe revision and keeps no-op metadata exact", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const created = await secrets.register(root, AGENT, {
            id: "rotating-token",
            description: "Rotating token",
            environment: { TOKEN: "old-value" },
        });
        const eventCount = store.postCommitEvents.length;

        const updated = await secrets.update(
            root,
            AGENT,
            created.id,
            { environment: { TOKEN: "new-value" } },
            { operationId: "rotating-token-update" },
        );
        expect(updated).toEqual({
            id: created.id,
            description: created.description,
            environmentVariables: ["TOKEN"],
            revision: "2",
        });
        expect(store.postCommitEvents).toHaveLength(eventCount + 1);
        expect(store.postCommitEvents.at(-1)).toMatchObject({
            type: "secret_updated",
            secret: updated,
        });
        expect(JSON.stringify(store.receipts)).not.toContain("new-value");
        expect(secrets.formatForModel({ secrets: [updated!], limit: 1 })).not.toContain(
            "new-value",
        );

        const noOp = await secrets.update(
            root,
            AGENT,
            created.id,
            { environment: { TOKEN: "new-value" } },
            { operationId: "rotating-token-no-op" },
        );
        expect(noOp).toEqual(updated);
        expect(store.postCommitEvents).toHaveLength(eventCount + 1);
        expect(store.records.get(created.id)?.revision).toBe("2");
    });

    it("replays an attach receipt after detach without reading or mutating current state", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const created = await secrets.register(root, AGENT, {
            id: "attach-replay",
            description: "Attach replay",
            environment: { TOKEN: "value" },
        });
        const attachOptions = { operationId: "attach-replay-operation" };
        const first = await secrets.attach(
            root,
            AGENT,
            "attach-replay-scope",
            created.id,
            attachOptions,
        );

        await expect(
            secrets.detach(root, AGENT, "attach-replay-scope", created.id, {
                operationId: "attach-replay-detach",
            }),
        ).resolves.toBe(true);
        const afterDetach = cloneAttachments(store.attachments);
        const receiptsBeforeReplay = cloneReceipts(store.receipts);
        const proofsBeforeReplay = cloneProofs(store.proofs);
        const callsBeforeReplay = store.calls.length;
        const transactionalEventsBeforeReplay = store.transactionalEvents.length;
        const postCommitEventsBeforeReplay = store.postCommitEvents.length;

        await expect(
            secrets.attach(root, AGENT, "attach-replay-scope", created.id, attachOptions),
        ).resolves.toEqual(first);
        expect(store.attachments).toEqual(afterDetach);
        expect(store.receipts).toEqual(receiptsBeforeReplay);
        expect(store.proofs).toEqual(proofsBeforeReplay);
        expect(store.calls.slice(callsBeforeReplay)).toEqual([
            { method: "readReceipt", agentId: AGENT },
            { method: "readMutationProof", agentId: AGENT },
        ]);
        expect(store.transactionalEvents).toHaveLength(transactionalEventsBeforeReplay);
        expect(store.postCommitEvents).toHaveLength(postCommitEventsBeforeReplay);

        await secrets.attach(root, AGENT, "attach-replay-scope", created.id, {
            operationId: "attach-replay-newer",
        });
        const afterNewerAttach = cloneAttachments(store.attachments);
        const callsBeforeNewerReplay = store.calls.length;
        await expect(
            secrets.attach(root, AGENT, "attach-replay-scope", created.id, attachOptions),
        ).resolves.toEqual(first);
        expect(store.attachments).toEqual(afterNewerAttach);
        expect(store.calls.slice(callsBeforeNewerReplay)).toEqual([
            { method: "readReceipt", agentId: AGENT },
            { method: "readMutationProof", agentId: AGENT },
        ]);
    });

    it("replays an attach tool result from its safe historical reference after removal", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const created = await secrets.register(root, AGENT, {
            id: "tool-attach-replay",
            description: "Tool attach replay",
            environment: { TOKEN: "never-returned" },
        });
        const scope = { agent: { id: AGENT } } as Parameters<SecretsFeature["tools"]>[1];
        const tool = secrets.tools(root, scope).find((value) => value.name === "attach_secret")!;
        const toolCtx = callCtx();
        const input = { scopeRef: "tool-replay-scope", secretId: created.id };
        const first = await tool.execute(toolCtx, input);
        const firstText = (await tool.toLLM(first))[0]!;

        await expect(
            secrets.remove(root, AGENT, created.id, { operationId: "remove-after-tool-attach" }),
        ).resolves.toBe(true);
        const callsBeforeReplay = store.calls.length;
        const transactionalEventsBeforeReplay = store.transactionalEvents.length;
        const postCommitEventsBeforeReplay = store.postCommitEvents.length;

        await expect(tool.execute(toolCtx, input)).resolves.toEqual(first);
        expect(store.calls.slice(callsBeforeReplay)).toEqual([
            { method: "readReceipt", agentId: AGENT },
            { method: "readMutationProof", agentId: AGENT },
        ]);
        expect(store.transactionalEvents).toHaveLength(transactionalEventsBeforeReplay);
        expect(store.postCommitEvents).toHaveLength(postCommitEventsBeforeReplay);
        expect((await tool.toLLM(first))[0]).toEqual(firstText);
        expect(JSON.stringify(first)).not.toContain("never-returned");
    });

    it("requires attach replay receipts to match an immutable safe result proof", async () => {
        const fixture = async () => {
            const store = new MemorySecretStore();
            const secrets = feature(store);
            await secrets.register(root, AGENT, {
                id: "attach-proof",
                description: "Attach proof",
                environment: { TOKEN: "value" },
            });
            const options = { operationId: "attach-proof-operation" };
            await secrets.attach(root, AGENT, "attach-proof-scope", "attach-proof", options);
            await secrets.detach(root, AGENT, "attach-proof-scope", "attach-proof", {
                operationId: "attach-proof-detach",
            });
            return { store, secrets, options };
        };

        const missingProof = await fixture();
        missingProof.store.proofs.delete(receiptKey(AGENT, missingProof.options.operationId));
        const missingProofAttachments = cloneAttachments(missingProof.store.attachments);
        const missingProofAttachCalls = missingProof.store.calls.filter(
            (call) => call.method === "attach",
        ).length;
        await expect(
            missingProof.secrets.attach(
                root,
                AGENT,
                "attach-proof-scope",
                "attach-proof",
                missingProof.options,
            ),
        ).rejects.toThrow("no immutable mutation proof");
        expect(missingProof.store.attachments).toEqual(missingProofAttachments);
        expect(missingProof.store.calls.filter((call) => call.method === "attach")).toHaveLength(
            missingProofAttachCalls,
        );

        const danglingProof = await fixture();
        danglingProof.store.receipts.delete(receiptKey(AGENT, danglingProof.options.operationId));
        const danglingProofAttachments = cloneAttachments(danglingProof.store.attachments);
        await expect(
            danglingProof.secrets.attach(
                root,
                AGENT,
                "attach-proof-scope",
                "attach-proof",
                danglingProof.options,
            ),
        ).rejects.toThrow("proof without its receipt");
        expect(danglingProof.store.attachments).toEqual(danglingProofAttachments);

        const tamperedReceipt = await fixture();
        const receipt = tamperedReceipt.store.receipts.get(
            receiptKey(AGENT, tamperedReceipt.options.operationId),
        )!;
        if (receipt.result.operation !== "attach" || receipt.result.reference === undefined) {
            throw new Error("expected attach receipt with a safe reference");
        }
        receipt.result.reference = {
            ...receipt.result.reference,
            revision: "tampered-revision",
            description: "Tampered description",
            environmentVariables: ["FORGED"],
        };
        const tamperedReceiptAttachments = cloneAttachments(tamperedReceipt.store.attachments);
        await expect(
            tamperedReceipt.secrets.attach(
                root,
                AGENT,
                "attach-proof-scope",
                "attach-proof",
                tamperedReceipt.options,
            ),
        ).rejects.toThrow("does not match its immutable mutation proof");
        expect(tamperedReceipt.store.attachments).toEqual(tamperedReceiptAttachments);

        const tamperedProof = await fixture();
        const proof = tamperedProof.store.proofs.get(
            receiptKey(AGENT, tamperedProof.options.operationId),
        )!;
        if (proof.operation !== "attach") {
            throw new Error("expected attach proof");
        }
        proof.reference = {
            ...proof.reference,
            id: "other-secret",
        };
        const tamperedProofAttachments = cloneAttachments(tamperedProof.store.attachments);
        await expect(
            tamperedProof.secrets.attach(
                root,
                AGENT,
                "attach-proof-scope",
                "attach-proof",
                tamperedProof.options,
            ),
        ).rejects.toThrow("invalid result snapshot");
        expect(tamperedProof.store.attachments).toEqual(tamperedProofAttachments);
    });

    it("reconciles malformed host results and rolls back transactional listeners", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        store.corruptRegisterResult = true;
        await expect(
            secrets.register(root, AGENT, {
                id: "bad",
                description: "Bad",
                environment: { TOKEN: "value" },
            }),
        ).rejects.toThrow("authoritatively");
        expect(store.transactionalEvents).toHaveLength(0);
        expect(store.postCommitEvents).toHaveLength(0);
        expect(store.records).toHaveLength(0);

        const failing = feature(store, {
            listener: {
                onEventTransactional: () => {
                    throw new Error("listener failed");
                },
            },
        });
        store.corruptRegisterResult = false;
        await expect(
            failing.register(root, AGENT, {
                id: "rollback",
                description: "Rollback",
                environment: { TOKEN: "value" },
            }),
        ).rejects.toThrow("listener failed");
        expect(store.records.has("rollback")).toBe(false);
        expect(store.postCommitEvents).toHaveLength(0);
    });

    it("rejects schema-valid changed flags and non-void after-commit registration", async () => {
        const registerStore = new MemorySecretStore();
        const malformedRegisterStore: SecretStore = {
            ...registerStore.contract,
            register: async (ctx, agentId, registration, operation) => {
                const result = await registerStore.register(ctx, agentId, registration, operation);
                return { ...result, changed: !result.changed };
            },
        };
        const malformedRegister = new SecretsFeature({ store: malformedRegisterStore });
        await expect(
            malformedRegister.register(root, AGENT, {
                id: "wrong-change",
                description: "Wrong change",
                environment: { TOKEN: "value" },
            }),
        ).rejects.toThrow("authoritatively");
        expect(registerStore.records).toHaveLength(0);

        const updateStore = new MemorySecretStore();
        const updateFeature = feature(updateStore);
        await updateFeature.register(root, AGENT, {
            id: "wrong-update-change",
            description: "Before",
            environment: { TOKEN: "value" },
        });
        const malformedUpdateStore: SecretStore = {
            ...updateStore.contract,
            update: async (ctx, agentId, secretId, input, operation) => {
                const result = await updateStore.update(ctx, agentId, secretId, input, operation);
                return { ...result, changed: !result.changed };
            },
        };
        const malformedUpdate = new SecretsFeature({
            store: malformedUpdateStore,
            mutationIdFactory: () => "wrong-update-change-op",
            eventIdFactory: () => "wrong-update-change-event",
            clock: () => 1,
        });
        await expect(
            malformedUpdate.update(root, AGENT, "wrong-update-change", {
                description: "After",
            }),
        ).rejects.toThrow("authoritatively");
        expect(
            (await updateFeature.reference(root, AGENT, "wrong-update-change"))?.description,
        ).toBe("Before");

        for (const returned of [42, Promise.resolve()] as const) {
            const afterCommitStore = new MemorySecretStore();
            const invalidAfterCommitStore: SecretStore = {
                ...afterCommitStore.contract,
                afterCommit: (() => returned) as unknown as SecretStore["afterCommit"],
            };
            const invalidAfterCommit = new SecretsFeature({
                store: invalidAfterCommitStore,
                idFactory: () => `after-commit-${typeof returned}`,
                mutationIdFactory: () => `after-commit-op-${typeof returned}`,
                eventIdFactory: () => `after-commit-event-${typeof returned}`,
                clock: () => 1,
            });
            await expect(
                invalidAfterCommit.register(root, AGENT, {
                    id: `after-commit-${typeof returned}`,
                    description: "Invalid after commit",
                    environment: { TOKEN: "value" },
                }),
            ).rejects.toThrow("afterCommit");
            expect(afterCommitStore.records).toHaveLength(0);
        }
    });

    it("does not publish post-commit events before the outer transaction commits", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        await store
            .transaction(root, async (txCtx) => {
                await secrets.register(txCtx, AGENT, {
                    id: "nested",
                    description: "Nested",
                    environment: { TOKEN: "value" },
                });
                expect(store.postCommitEvents).toHaveLength(0);
                throw new Error("outer rollback");
            })
            .catch(() => undefined);
        expect(store.records.has("nested")).toBe(false);
        expect(store.postCommitEvents).toHaveLength(0);
        expect(store.transactionalEvents).toHaveLength(1);

        await secrets.register(root, AGENT, {
            id: "committed",
            description: "Committed",
            environment: { TOKEN: "value" },
        });
        expect(store.postCommitEvents).toHaveLength(1);
        expect(store.postCommitEvents[0]).toBe(
            store.transactionalEvents[store.transactionalEvents.length - 1],
        );
        expect(Object.isFrozen(store.postCommitEvents[0])).toBe(true);
        const event = store.postCommitEvents[0]!;
        if (event.type !== "secret_registered") throw new Error("expected registration event");
        expect(Object.isFrozen(event.secret)).toBe(true);
    });

    it("rejects malformed pages, cursors, options, and cross-agent scope authorization", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store, {
            authorize: (_ctx, agentId) => agentId === AGENT,
        });
        const authorizationCalls: string[] = [];
        const validating = feature(store, {
            authorize: (_ctx, _agentId, operation) => {
                authorizationCalls.push(operation);
                return true;
            },
        });
        await expect(secrets.list(root, AGENT)).resolves.toEqual({
            secrets: [],
            limit: 50,
        });
        await expect(secrets.list(root, AGENT, {})).resolves.toEqual({
            secrets: [],
            limit: 50,
        });
        await expect(
            validating.list(root, AGENT, {
                unexpected: true,
            } as unknown as SecretListInput),
        ).rejects.toThrow("query");
        await expect(
            validating.list(root, AGENT, "not-an-object" as unknown as SecretListQuery),
        ).rejects.toThrow("query");
        expect(authorizationCalls).toHaveLength(0);

        await expect(secrets.list(root, AGENT, { limit: 0 })).rejects.toThrow("query");
        await expect(
            secrets.list(root, AGENT, {
                limit: 1,
                cursor: "opaque" as unknown as number,
            }),
        ).rejects.toThrow("query");
        await expect(secrets.attach(root, OTHER_AGENT, "scope", "missing")).rejects.toThrow(
            "authorized",
        );
        await expect(secrets.resolveForHost(root, OTHER_AGENT, "scope")).rejects.toThrow(
            "authorized",
        );

        const malformed = {
            ...store.contract,
            list: async () => ({
                secrets: [],
                limit: 1,
                nextCursor: 1,
            }),
        };
        const malformedFeature = new SecretsFeature({
            store: malformed,
            maxPageSize: 1,
        });
        await expect(malformedFeature.list(root, AGENT, { limit: 1, cursor: 1 })).rejects.toThrow(
            "cursor",
        );

        const cursorStore = new MemorySecretStore();
        const cursorFeature = feature(cursorStore);
        await cursorFeature.register(root, AGENT, {
            id: "cursor",
            description: "Cursor",
            environment: { TOKEN: "value" },
        });
        await cursorFeature.register(root, AGENT, {
            id: "cursor-next",
            description: "Cursor next",
            environment: { TOKEN_NEXT: "value" },
        });
        const firstPage = await cursorFeature.list(root, AGENT, { limit: 1 });
        const nextCursor = firstPage.nextCursor;
        expect(nextCursor).toBe(1);
        if (nextCursor === undefined) throw new Error("expected a continuation cursor");
        expect(
            (
                await cursorFeature.list(root, AGENT, {
                    limit: 1,
                    cursor: nextCursor,
                })
            ).secrets[0]?.id,
        ).toBe("cursor-next");
        const unsafeCursorStore: SecretStore = {
            ...cursorStore.contract,
            list: async (_ctx, _agentId, query) => ({
                secrets: [(await cursorStore.contract.reference(root, AGENT, "cursor"))!],
                limit: query.limit,
                nextCursor: 2,
            }),
        };
        const unsafeCursorFeature = new SecretsFeature({
            store: unsafeCursorStore,
            maxPageSize: 1,
        });
        await expect(unsafeCursorFeature.list(root, AGENT, { limit: 1 })).rejects.toThrow("cursor");
    });

    it("requires object-form attachment options and validates both requested IDs", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const created = await secrets.register(root, AGENT, {
            id: "object-input",
            description: "Object input",
            environment: { TOKEN: "value" },
        });

        await expect(
            secrets.attach(
                root,
                AGENT,
                { scopeRef: "scope", secretId: created.id },
                "not-options" as unknown as SecretMutationOptions,
            ),
        ).rejects.toThrow("options");
        await expect(
            secrets.detach(
                root,
                AGENT,
                { scopeRef: "scope", secretId: created.id },
                42 as unknown as SecretMutationOptions,
            ),
        ).rejects.toThrow("options");
        await expect(
            secrets.attach(root, AGENT, {
                scopeRef: "scope",
                secretId: "not a secret id",
            } as unknown as SecretAttachInput),
        ).rejects.toThrow("input");
        await expect(
            secrets.detach(root, AGENT, {
                scopeRef: "scope",
                secretId: "",
            } as unknown as SecretAttachInput),
        ).rejects.toThrow("input");
    });

    it("rejects missing-before mutations when the host creates authoritative after-state", async () => {
        const updateStore = new MemorySecretStore();
        const inconsistentUpdateStore: SecretStore = {
            ...updateStore.contract,
            update: async (ctx, agentId, secretId, _input, operation) => {
                updateStore.records.set(secretId, {
                    id: secretId,
                    description: "created unexpectedly",
                    environment: {},
                    ownerAgentId: agentId,
                    revision: "1",
                });
                return {
                    operation: "update",
                    ...operation,
                    changed: false,
                    secretId,
                };
            },
        };
        await expect(
            feature(updateStore, { store: inconsistentUpdateStore }).update(
                root,
                AGENT,
                "missing",
                {
                    description: "ignored",
                },
            ),
        ).rejects.toThrow("missing secret");
        expect(updateStore.records.has("missing")).toBe(false);

        const removeStore = new MemorySecretStore();
        const inconsistentRemoveStore: SecretStore = {
            ...removeStore.contract,
            remove: async (ctx, agentId, secretId, operation) => {
                removeStore.records.set(secretId, {
                    id: secretId,
                    description: "created unexpectedly",
                    environment: {},
                    ownerAgentId: agentId,
                    revision: "1",
                });
                return {
                    operation: "remove",
                    ...operation,
                    removed: false,
                    secretId,
                };
            },
        };
        await expect(
            feature(removeStore, { store: inconsistentRemoveStore }).remove(root, AGENT, "missing"),
        ).rejects.toThrow("created");
        expect(removeStore.records.has("missing")).toBe(false);

        const detachStore = new MemorySecretStore();
        const inconsistentDetachStore: SecretStore = {
            ...detachStore.contract,
            detach: async (ctx, agentId, input, operation) => {
                const key = attachmentKey(agentId, input.scopeRef);
                detachStore.attachments.set(key, new Set([input.secretId]));
                return {
                    operation: "detach",
                    ...operation,
                    detached: false,
                };
            },
        };
        await expect(
            feature(detachStore, { store: inconsistentDetachStore }).detach(
                root,
                AGENT,
                "scope",
                "missing",
            ),
        ).rejects.toThrow("created");
        expect(detachStore.attachments.has(attachmentKey(AGENT, "scope"))).toBe(false);
    });

    it("requires register and update reconciliation to match requested normalized semantics", async () => {
        const registerStore = new MemorySecretStore();
        const inconsistentRegisterStore: SecretStore = {
            ...registerStore.contract,
            register: async (ctx, agentId, registration, operation) => {
                const result = await registerStore.register(ctx, agentId, registration, operation);
                registerStore.records.set(registration.id, {
                    ...registration,
                    description: "Host description",
                    environment: { HOST_ONLY: "host-value" },
                    ownerAgentId: agentId,
                    revision: "1",
                });
                return {
                    ...result,
                    reference: {
                        id: registration.id,
                        description: "Host description",
                        environmentVariables: ["HOST_ONLY"],
                        revision: "1",
                    },
                };
            },
        };
        await expect(
            feature(registerStore, { store: inconsistentRegisterStore }).register(root, AGENT, {
                id: "register-reconciliation",
                description: "Requested description",
                environment: { REQUESTED: "requested-value" },
            }),
        ).rejects.toThrow("authoritatively");
        expect(registerStore.records.has("register-reconciliation")).toBe(false);

        const updateCases = [
            {
                id: "preserve-omitted-description",
                initial: {
                    description: "Original description",
                    environment: { TOKEN: "value" },
                },
                input: { environment: { NEXT: "next-value" } },
                alter: (record: StoredSecret): StoredSecret => ({
                    ...record,
                    description: "Unexpected description",
                }),
            },
            {
                id: "preserve-omitted-environment",
                initial: {
                    description: "Original description",
                    environment: { TOKEN: "value" },
                },
                input: { description: "Updated description" },
                alter: (record: StoredSecret): StoredSecret => ({
                    ...record,
                    environment: { OTHER: "other-value" },
                }),
            },
        ];

        for (const testCase of updateCases) {
            const store = new MemorySecretStore();
            const base = feature(store);
            await base.register(root, AGENT, {
                id: testCase.id,
                description: testCase.initial.description,
                environment: testCase.initial.environment,
            });
            const inconsistentStore: SecretStore = {
                ...store.contract,
                update: async (ctx, agentId, secretId, input, operation) => {
                    const result = await store.update(ctx, agentId, secretId, input, operation);
                    const current = store.records.get(secretId);
                    if (current === undefined) throw new Error("test secret disappeared");
                    const altered = testCase.alter(current);
                    store.records.set(secretId, altered);
                    return {
                        ...result,
                        reference: {
                            id: altered.id,
                            description: altered.description,
                            environmentVariables: Object.keys(altered.environment).sort(),
                            revision: altered.revision,
                        },
                    };
                },
            };
            const malformed = new SecretsFeature({
                store: inconsistentStore,
                mutationIdFactory: () => `${testCase.id}-operation`,
                eventIdFactory: () => `${testCase.id}-event`,
                clock: () => 1,
            });
            await expect(
                malformed.update(root, AGENT, testCase.id, testCase.input),
            ).rejects.toThrow("authoritatively");
            expect((await base.reference(root, AGENT, testCase.id))?.description).toBe(
                "Original description",
            );
            expect((await base.reference(root, AGENT, testCase.id))?.environmentVariables).toEqual([
                "TOKEN",
            ]);
        }
    });

    it("preserves own __proto__ environment keys from JSON-parsed registration and patches", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const registration = JSON.parse(
            '{"id":"json-proto-registration","description":"JSON proto","environment":{"__proto__":"proto-value","TOKEN":"token-value"}}',
        ) as SecretRegistrationInput;
        const created = await secrets.register(root, AGENT, registration);
        expect(created.environmentVariables).toEqual(["__proto__", "TOKEN"]);
        expect(Object.hasOwn(store.records.get(created.id)!.environment, "__proto__")).toBe(true);

        const patchRegistration = JSON.parse(
            '{"id":"json-proto-patch","description":"JSON proto patch","environment":{"TOKEN":"token-value"}}',
        ) as SecretRegistrationInput;
        const patchCreated = await secrets.register(root, AGENT, patchRegistration);
        const patch = JSON.parse(
            '{"environment":{"__proto__":"patched-proto-value"}}',
        ) as SecretUpdateInput;
        const updated = await secrets.update(root, AGENT, patchCreated.id, patch);
        expect(updated?.environmentVariables).toEqual(["__proto__", "TOKEN"]);
        expect(Object.hasOwn(store.records.get(patchCreated.id)!.environment, "__proto__")).toBe(
            true,
        );
    });

    it("bounds canonical fingerprint input after normalization", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const environment = Object.fromEntries(
            Array.from({ length: 4 }, (_, index) => [`TOKEN_${index}`, "x".repeat(65_000)]),
        );

        await expect(
            secrets.register(root, AGENT, {
                id: "large-fingerprint",
                description: "Large fingerprint",
                environment,
            }),
        ).rejects.toThrow("encoded byte bound");
        expect(store.records.has("large-fingerprint")).toBe(false);
    });

    it("verifies every scoped page result has an authoritative attachment", async () => {
        const store = new MemorySecretStore();
        const created = await feature(store).register(root, AGENT, {
            id: "scoped-page",
            description: "Scoped page",
            environment: { TOKEN: "value" },
        });
        const malformedStore: SecretStore = {
            ...store.contract,
            list: async (ctx, agentId, query) => ({
                secrets: [(await store.reference(ctx, agentId, created.id))!],
                limit: query.limit,
            }),
        };
        const secrets = feature(store, { store: malformedStore });

        await expect(
            secrets.list(root, AGENT, {
                limit: 1,
                scopeRef: "scope-without-attachment",
            }),
        ).rejects.toThrow("not attached");
        expect(store.calls.filter((call) => call.method === "attachment")).toHaveLength(1);
    });

    it("stores durable identities in call-scoped KV and supports all mutation kinds", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const ctx = callCtx();
        const registered = await secrets.register(ctx, AGENT, {
            description: "Token",
            environment: { TOKEN: "value" },
        });
        await secrets.update(ctx, AGENT, registered.id, { description: "Updated" });
        await secrets.attach(ctx, AGENT, "scope", registered.id);
        expect(await secrets.detach(ctx, AGENT, "scope", registered.id)).toBe(true);
        expect(await secrets.remove(ctx, AGENT, registered.id)).toBe(true);
    });

    it("does not reuse one call-scoped identity for independent mutations", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store);
        const ctx = callCtx();

        const first = await secrets.register(ctx, AGENT, {
            description: "First",
            environment: { FIRST: "one" },
        });
        const second = await secrets.register(ctx, AGENT, {
            description: "Second",
            environment: { SECOND: "two" },
        });

        expect(second.id).not.toBe(first.id);
        expect(store.records.has(first.id)).toBe(true);
        expect(store.records.has(second.id)).toBe(true);
    });

    it("rejects forged mutation metadata and reconciles stale replay receipts", async () => {
        const store = new MemorySecretStore();
        const original = feature(store);
        const created = await original.register(root, AGENT, {
            id: "forged",
            description: "Original",
            environment: { TOKEN: "value" },
        });

        const malformedUpdateStore: SecretStore = {
            ...store.contract,
            update: async (ctx, agentId, secretId, input, operation) => {
                const result = await store.update(ctx, agentId, secretId, input, operation);
                if (!("reference" in result) || result.reference === undefined) return result;
                return {
                    ...result,
                    reference: { ...result.reference, description: "forged metadata" },
                };
            },
        };
        const malformedUpdate = new SecretsFeature({
            store: malformedUpdateStore,
            mutationIdFactory: () => "update-forged",
            eventIdFactory: () => "event-update-forged",
            clock: () => 1,
        });
        await expect(
            malformedUpdate.update(root, AGENT, created.id, { description: "Changed" }),
        ).rejects.toThrow("authoritatively");
        expect((await original.reference(root, AGENT, created.id))?.description).toBe("Original");

        const operationId = "register-replay";
        await original.register(
            root,
            AGENT,
            {
                id: "replay",
                description: "Replay",
                environment: { TOKEN: "value" },
            },
            { operationId },
        );
        store.records.set("replay", {
            ...store.records.get("replay")!,
            description: "Changed outside the receipt",
        });
        await expect(
            original.register(
                root,
                AGENT,
                {
                    id: "replay",
                    description: "Replay",
                    environment: { TOKEN: "value" },
                },
                { operationId },
            ),
        ).resolves.toEqual({
            id: "replay",
            description: "Changed outside the receipt",
            environmentVariables: ["TOKEN"],
            revision: "1",
        });
    });

    it("replays destructive outcomes from immutable proofs across newer state", async () => {
        const absentRemoveStore = new MemorySecretStore();
        const absentRemoveFeature = feature(absentRemoveStore);
        const absentRemoveOptions = { operationId: "remove-absent-first" };
        await expect(
            absentRemoveFeature.remove(root, AGENT, "absent-remove", absentRemoveOptions),
        ).resolves.toBe(false);
        await absentRemoveFeature.register(root, AGENT, {
            id: "absent-remove",
            description: "Recreated after absent remove",
            environment: { TOKEN: "value" },
        });
        const absentRemoveRecords = cloneMap(absentRemoveStore.records);
        const absentRemoveAttachments = cloneAttachments(absentRemoveStore.attachments);
        const absentRemoveCalls = absentRemoveStore.calls.filter(
            (call) => call.method === "remove",
        ).length;
        const absentRemoveReceiptWrites = absentRemoveStore.calls.filter(
            (call) => call.method === "writeReceipt",
        ).length;
        const absentRemoveProofWrites = absentRemoveStore.calls.filter(
            (call) => call.method === "writeMutationProof",
        ).length;
        const absentRemoveTransactionalEvents = absentRemoveStore.transactionalEvents.length;
        const absentRemovePostCommitEvents = absentRemoveStore.postCommitEvents.length;
        await expect(
            absentRemoveFeature.remove(root, AGENT, "absent-remove", absentRemoveOptions),
        ).resolves.toBe(false);
        expect(absentRemoveStore.records).toEqual(absentRemoveRecords);
        expect(absentRemoveStore.attachments).toEqual(absentRemoveAttachments);
        expect(absentRemoveStore.calls.filter((call) => call.method === "remove")).toHaveLength(
            absentRemoveCalls,
        );
        expect(
            absentRemoveStore.calls.filter((call) => call.method === "writeReceipt"),
        ).toHaveLength(absentRemoveReceiptWrites);
        expect(
            absentRemoveStore.calls.filter((call) => call.method === "writeMutationProof"),
        ).toHaveLength(absentRemoveProofWrites);
        expect(absentRemoveStore.transactionalEvents).toHaveLength(absentRemoveTransactionalEvents);
        expect(absentRemoveStore.postCommitEvents).toHaveLength(absentRemovePostCommitEvents);

        const successfulRemoveStore = new MemorySecretStore();
        const successfulRemoveFeature = feature(successfulRemoveStore);
        const successfulRemoveOptions = { operationId: "remove-successful" };
        await successfulRemoveFeature.register(root, AGENT, {
            id: "successful-remove",
            description: "Before remove",
            environment: { BEFORE: "value" },
        });
        await expect(
            successfulRemoveFeature.remove(
                root,
                AGENT,
                "successful-remove",
                successfulRemoveOptions,
            ),
        ).resolves.toBe(true);
        await successfulRemoveFeature.register(root, AGENT, {
            id: "successful-remove",
            description: "Recreated after successful remove",
            environment: { AFTER: "value" },
        });
        const successfulRemoveRecords = cloneMap(successfulRemoveStore.records);
        const successfulRemoveAttachments = cloneAttachments(successfulRemoveStore.attachments);
        const successfulRemoveCalls = successfulRemoveStore.calls.filter(
            (call) => call.method === "remove",
        ).length;
        const successfulRemoveReceiptWrites = successfulRemoveStore.calls.filter(
            (call) => call.method === "writeReceipt",
        ).length;
        const successfulRemoveProofWrites = successfulRemoveStore.calls.filter(
            (call) => call.method === "writeMutationProof",
        ).length;
        const successfulRemoveTransactionalEvents =
            successfulRemoveStore.transactionalEvents.length;
        const successfulRemovePostCommitEvents = successfulRemoveStore.postCommitEvents.length;
        await expect(
            successfulRemoveFeature.remove(
                root,
                AGENT,
                "successful-remove",
                successfulRemoveOptions,
            ),
        ).resolves.toBe(true);
        expect(successfulRemoveStore.records).toEqual(successfulRemoveRecords);
        expect(successfulRemoveStore.attachments).toEqual(successfulRemoveAttachments);
        expect(successfulRemoveStore.calls.filter((call) => call.method === "remove")).toHaveLength(
            successfulRemoveCalls,
        );
        expect(
            successfulRemoveStore.calls.filter((call) => call.method === "writeReceipt"),
        ).toHaveLength(successfulRemoveReceiptWrites);
        expect(
            successfulRemoveStore.calls.filter((call) => call.method === "writeMutationProof"),
        ).toHaveLength(successfulRemoveProofWrites);
        expect(successfulRemoveStore.transactionalEvents).toHaveLength(
            successfulRemoveTransactionalEvents,
        );
        expect(successfulRemoveStore.postCommitEvents).toHaveLength(
            successfulRemovePostCommitEvents,
        );

        const absentDetachStore = new MemorySecretStore();
        const absentDetachFeature = feature(absentDetachStore);
        const absentDetachOptions = { operationId: "detach-absent-first" };
        await absentDetachFeature.register(root, AGENT, {
            id: "absent-detach",
            description: "Absent detach",
            environment: { TOKEN: "value" },
        });
        await expect(
            absentDetachFeature.detach(
                root,
                AGENT,
                "absent-detach-scope",
                "absent-detach",
                absentDetachOptions,
            ),
        ).resolves.toBe(false);
        await absentDetachFeature.attach(root, AGENT, "absent-detach-scope", "absent-detach");
        const absentDetachRecords = cloneMap(absentDetachStore.records);
        const absentDetachAttachments = cloneAttachments(absentDetachStore.attachments);
        const absentDetachCalls = absentDetachStore.calls.filter(
            (call) => call.method === "detach",
        ).length;
        const absentDetachReceiptWrites = absentDetachStore.calls.filter(
            (call) => call.method === "writeReceipt",
        ).length;
        const absentDetachProofWrites = absentDetachStore.calls.filter(
            (call) => call.method === "writeMutationProof",
        ).length;
        const absentDetachTransactionalEvents = absentDetachStore.transactionalEvents.length;
        const absentDetachPostCommitEvents = absentDetachStore.postCommitEvents.length;
        await expect(
            absentDetachFeature.detach(
                root,
                AGENT,
                "absent-detach-scope",
                "absent-detach",
                absentDetachOptions,
            ),
        ).resolves.toBe(false);
        expect(absentDetachStore.records).toEqual(absentDetachRecords);
        expect(absentDetachStore.attachments).toEqual(absentDetachAttachments);
        expect(absentDetachStore.calls.filter((call) => call.method === "detach")).toHaveLength(
            absentDetachCalls,
        );
        expect(
            absentDetachStore.calls.filter((call) => call.method === "writeReceipt"),
        ).toHaveLength(absentDetachReceiptWrites);
        expect(
            absentDetachStore.calls.filter((call) => call.method === "writeMutationProof"),
        ).toHaveLength(absentDetachProofWrites);
        expect(absentDetachStore.transactionalEvents).toHaveLength(absentDetachTransactionalEvents);
        expect(absentDetachStore.postCommitEvents).toHaveLength(absentDetachPostCommitEvents);

        const successfulDetachStore = new MemorySecretStore();
        const successfulDetachFeature = feature(successfulDetachStore);
        const successfulDetachOptions = { operationId: "detach-successful" };
        await successfulDetachFeature.register(root, AGENT, {
            id: "successful-detach",
            description: "Successful detach",
            environment: { TOKEN: "value" },
        });
        await successfulDetachFeature.attach(
            root,
            AGENT,
            "successful-detach-scope",
            "successful-detach",
        );
        await expect(
            successfulDetachFeature.detach(
                root,
                AGENT,
                "successful-detach-scope",
                "successful-detach",
                successfulDetachOptions,
            ),
        ).resolves.toBe(true);
        await successfulDetachFeature.attach(
            root,
            AGENT,
            "successful-detach-scope",
            "successful-detach",
        );
        const successfulDetachRecords = cloneMap(successfulDetachStore.records);
        const successfulDetachAttachments = cloneAttachments(successfulDetachStore.attachments);
        const successfulDetachCalls = successfulDetachStore.calls.filter(
            (call) => call.method === "detach",
        ).length;
        const successfulDetachReceiptWrites = successfulDetachStore.calls.filter(
            (call) => call.method === "writeReceipt",
        ).length;
        const successfulDetachProofWrites = successfulDetachStore.calls.filter(
            (call) => call.method === "writeMutationProof",
        ).length;
        const successfulDetachTransactionalEvents =
            successfulDetachStore.transactionalEvents.length;
        const successfulDetachPostCommitEvents = successfulDetachStore.postCommitEvents.length;
        await expect(
            successfulDetachFeature.detach(
                root,
                AGENT,
                "successful-detach-scope",
                "successful-detach",
                successfulDetachOptions,
            ),
        ).resolves.toBe(true);
        expect(successfulDetachStore.records).toEqual(successfulDetachRecords);
        expect(successfulDetachStore.attachments).toEqual(successfulDetachAttachments);
        expect(successfulDetachStore.calls.filter((call) => call.method === "detach")).toHaveLength(
            successfulDetachCalls,
        );
        expect(
            successfulDetachStore.calls.filter((call) => call.method === "writeReceipt"),
        ).toHaveLength(successfulDetachReceiptWrites);
        expect(
            successfulDetachStore.calls.filter((call) => call.method === "writeMutationProof"),
        ).toHaveLength(successfulDetachProofWrites);
        expect(successfulDetachStore.transactionalEvents).toHaveLength(
            successfulDetachTransactionalEvents,
        );
        expect(successfulDetachStore.postCommitEvents).toHaveLength(
            successfulDetachPostCommitEvents,
        );

        const mismatchStore = new MemorySecretStore();
        const mismatchFeature = feature(mismatchStore);
        const mismatchOptions = { operationId: "detach-mismatch" };
        await expect(
            mismatchFeature.detach(
                root,
                AGENT,
                "mismatch-scope",
                "mismatch-secret",
                mismatchOptions,
            ),
        ).resolves.toBe(false);
        const mismatchReceipt = mismatchStore.receipts.get(
            receiptKey(AGENT, mismatchOptions.operationId),
        )!;
        if (mismatchReceipt.result.operation !== "detach") {
            throw new Error("expected detach receipt");
        }
        mismatchReceipt.result.detached = true;
        await expect(
            mismatchFeature.detach(
                root,
                AGENT,
                "mismatch-scope",
                "mismatch-secret",
                mismatchOptions,
            ),
        ).rejects.toThrow("immutable mutation proof");

        const missingProofStore = new MemorySecretStore();
        const missingProofFeature = feature(missingProofStore);
        const missingProofOptions = { operationId: "remove-missing-proof" };
        await expect(
            missingProofFeature.remove(root, AGENT, "missing-proof", missingProofOptions),
        ).resolves.toBe(false);
        missingProofStore.proofs.delete(receiptKey(AGENT, missingProofOptions.operationId));
        await expect(
            missingProofFeature.remove(root, AGENT, "missing-proof", missingProofOptions),
        ).rejects.toThrow("no immutable mutation proof");

        const tamperedProofStore = new MemorySecretStore();
        const tamperedProofFeature = feature(tamperedProofStore);
        const tamperedProofOptions = { operationId: "remove-tampered-proof" };
        await expect(
            tamperedProofFeature.remove(root, AGENT, "tampered-proof", tamperedProofOptions),
        ).resolves.toBe(false);
        const tamperedProof = tamperedProofStore.proofs.get(
            receiptKey(AGENT, tamperedProofOptions.operationId),
        )!;
        if (tamperedProof.operation !== "remove") {
            throw new Error("expected remove proof");
        }
        tamperedProof.removed = true;
        await expect(
            tamperedProofFeature.remove(root, AGENT, "tampered-proof", tamperedProofOptions),
        ).rejects.toThrow("before-state marker");
    });

    it("preserves method ownership for a class-backed host store", async () => {
        const secrets = new SecretsFeature({
            store: new ClassBackedSecretStore(),
            idFactory: () => "class-secret",
            mutationIdFactory: () => "class-operation",
            eventIdFactory: () => "class-event",
            clock: () => 1,
        });
        const created = await secrets.register(root, AGENT, {
            id: "class-secret",
            description: "Class-backed",
            environment: { TOKEN: "value" },
        });
        expect(await secrets.reference(root, AGENT, created.id)).toEqual(created);
    });

    it("rejects a valid reference returned for the wrong requested identity", async () => {
        const store = new MemorySecretStore();
        const first = feature(store);
        await first.register(root, AGENT, {
            id: "first",
            description: "First",
            environment: { FIRST: "one" },
        });
        await first.register(root, AGENT, {
            id: "second",
            description: "Second",
            environment: { SECOND: "two" },
        });
        const malformedStore: SecretStore = {
            ...store.contract,
            reference: async (ctx, agentId, secretId) => {
                const value = await store.reference(ctx, agentId, secretId);
                return value === undefined
                    ? undefined
                    : {
                          ...value,
                          id: value.id === "first" ? "second" : "first",
                      };
            },
        };
        const malformed = new SecretsFeature({ store: malformedStore });
        await expect(malformed.reference(root, AGENT, "first")).rejects.toThrow(
            "different reference identity",
        );
    });

    it("requires the host receipt write to be durable and read-back exact", async () => {
        const store = new MemorySecretStore();
        const noOpReceiptStore: SecretStore = {
            ...store.contract,
            writeReceipt: async () => undefined,
        };
        const secrets = new SecretsFeature({
            store: noOpReceiptStore,
            idFactory: () => "no-receipt",
            mutationIdFactory: () => "no-receipt-operation",
            eventIdFactory: () => "no-receipt-event",
            clock: () => 1,
        });
        await expect(
            secrets.register(root, AGENT, {
                id: "no-receipt",
                description: "No receipt",
                environment: { TOKEN: "value" },
            }),
        ).rejects.toThrow("did not persist");
        expect(store.records.has("no-receipt")).toBe(false);
        expect(store.transactionalEvents).toHaveLength(0);
    });

    it("requires immutable mutation proofs to be durably acknowledged", async () => {
        const store = new MemorySecretStore();
        const noOpProofStore: SecretStore = {
            ...store.contract,
            writeMutationProof: async () => undefined,
        };
        let operation = 0;
        const secrets = new SecretsFeature({
            store: noOpProofStore,
            idFactory: () => "no-proof",
            mutationIdFactory: () => `no-proof-operation-${++operation}`,
            eventIdFactory: () => "no-proof-event",
            clock: () => 1,
        });
        await secrets.register(root, AGENT, {
            id: "no-proof",
            description: "No proof",
            environment: { TOKEN: "value" },
        });
        await expect(secrets.remove(root, AGENT, "no-proof")).rejects.toThrow(
            "immutable mutation proof",
        );
        expect(store.records.has("no-proof")).toBe(true);
        expect(store.proofs).toHaveLength(0);
    });

    it("bounds attach and detach tool text at the configured model limit", async () => {
        const store = new MemorySecretStore();
        const secrets = feature(store, { maxOutputCharacters: 256 });
        const scopeRef = "s".repeat(100);
        const secretId = "s".repeat(128);
        const created = await secrets.register(root, AGENT, {
            id: secretId,
            description: "d".repeat(2_000),
            environment: { TOKEN: "value" },
        });
        await secrets.attach(root, AGENT, scopeRef, created.id);
        const scope = { agent: { id: AGENT } } as Parameters<SecretsFeature["tools"]>[1];
        const listTool = secrets.tools(root, scope).find((tool) => tool.name === "list_secrets")!;
        const listResult = await listTool.execute(root, { limit: 1 });
        const listText = ((await listTool.toLLM(listResult))[0] as { type: "text"; text: string })
            .text;
        expect(listText.length).toBeLessThanOrEqual(256);
        expect(listText).toContain(secretId);

        const attachTool = secrets
            .tools(root, scope)
            .find((tool) => tool.name === "attach_secret")!;
        const attachResult = await attachTool.execute(root, {
            scopeRef,
            secretId: created.id,
        });
        const attachText = (
            (await attachTool.toLLM(attachResult))[0] as { type: "text"; text: string }
        ).text;
        expect(attachText.length).toBeLessThanOrEqual(256);
        expect(attachText).toContain(scopeRef);
        expect(attachText).toContain(secretId);

        const detachTool = secrets
            .tools(root, scope)
            .find((tool) => tool.name === "detach_secret")!;
        const detachResult = await detachTool.execute(root, {
            scopeRef,
            secretId: created.id,
        });
        const detachText = (
            (await detachTool.toLLM(detachResult))[0] as { type: "text"; text: string }
        ).text;
        expect(detachText.length).toBeLessThanOrEqual(256);
        expect(detachText).toContain(scopeRef);
        expect(detachText).toContain(secretId);
        const noOpDetachResult = await detachTool.execute(root, {
            scopeRef,
            secretId: created.id,
        });
        const noOpDetachText = (
            (await detachTool.toLLM(noOpDetachResult))[0] as { type: "text"; text: string }
        ).text;
        expect(noOpDetachText.length).toBeLessThanOrEqual(256);
        expect(noOpDetachText).toContain(scopeRef);
        expect(noOpDetachText).toContain(secretId);
    });
});

class DurableValues {
    readonly values = new Map<string, unknown>();

    async transaction<Result>(
        _ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await work(root);
    }

    async load(): Promise<readonly []> {
        return [];
    }

    async append(): Promise<void> {}

    async clearRecords(): Promise<void> {}

    async readValues(_ctx: Context, prefix: string) {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: structuredClone(value) }));
    }

    async writeValue(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, structuredClone(value));
    }

    async deleteValue(_ctx: Context, key: string): Promise<void> {
        this.values.delete(key);
    }

    async writeValueIfAbsent(_ctx: Context, key: string, value: unknown): Promise<boolean> {
        if (this.values.has(key)) return false;
        this.values.set(key, structuredClone(value));
        return true;
    }
}
