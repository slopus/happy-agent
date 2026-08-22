import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import type {
    ProviderCredentialStatus,
    ProviderScanResponse,
    ProviderScanResult,
    ProviderVerificationLevel,
    ProviderVerificationResponse,
} from "@slopus/happy-agent-client";
import type { AgentModel, AgentModule } from "@slopus/happy-agent-base";
import type { BaseSession, SessionReasoningEffort } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, detach, withLifetime, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";

const MAX_STATE_BYTES = 64 * 1024;
const PROVIDER_PROBE_TIMEOUT_MS = 10_000;
const VERIFICATION_TIMEOUT_MS = 30_000;

const providerStateSchema = Type.Object(
    {
        overrides: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Boolean(), {
            maxProperties: 64,
        }),
        remembered: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
            maxItems: 64,
            uniqueItems: true,
        }),
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);

type ProviderState = Static<typeof providerStateSchema>;

/** Owns provider discovery, durable user overrides, and bounded account verification. */
export class ProviderScanModule implements AgentModule {
    readonly name = "provider-scan";

    readonly #config: ConfigModule;
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #remembered = new Set<string>();
    readonly #overrides = new Map<string, boolean>();
    readonly #verifications = new Map<string, Set<AbortController>>();
    #loaded = false;
    #owner: Context | undefined;
    #scanPromise: Promise<ProviderScanResponse> | undefined;

    constructor(config: ConfigModule) {
        this.#config = config;
    }

    /** Load durable discoveries, keep automatic providers off, then complete the startup scan. */
    async open(ctx: Context): Promise<ProviderScanResponse> {
        this.#owner ??= scanOwnerContext(ctx);
        await this.#load(ctx);
        return await this.scan(ctx);
    }

    /** Run or join the one current local credential scan. */
    async scan(ctx: Context): Promise<ProviderScanResponse> {
        const owner = (this.#owner ??= scanOwnerContext(ctx));
        await this.#load(ctx);
        if (this.#scanPromise !== undefined) return await this.#scanPromise;
        const running = this.#performScan(owner).finally(() => {
            if (this.#scanPromise === running) this.#scanPromise = undefined;
        });
        this.#scanPromise = running;
        return await running;
    }

    /** Persist a complete batch of explicit provider enablement changes. */
    async setOverrides(
        ctx: Context,
        providers: Readonly<Record<string, { readonly enabled: boolean }>>,
    ): Promise<void> {
        await this.#load(ctx);
        const changes = Object.entries(providers);
        for (const [providerId] of changes) this.#assertProvider(providerId);
        await this.#lock.runInLock(ctx, async () => {
            const nextOverrides = new Map(this.#overrides);
            for (const [providerId, value] of changes) {
                nextOverrides.set(providerId, value.enabled);
            }
            await this.#writeState(nextOverrides, this.#remembered);
            replaceMap(this.#overrides, nextOverrides);
            for (const [providerId, value] of changes) {
                this.#config.setProviderEnabled(providerId, value.enabled);
                if (!value.enabled) this.#abortVerifications(providerId);
            }
        });
    }

    /** Verify one configured provider without exposing any credential or vendor diagnostic. */
    async verify(
        ctx: Context,
        providerId: string,
        requestedLevel: ProviderVerificationLevel,
    ): Promise<ProviderVerificationResponse> {
        await this.#load(ctx);
        this.#assertProvider(providerId);
        const controller = new AbortController();
        const active = this.#verifications.get(providerId) ?? new Set<AbortController>();
        active.add(controller);
        this.#verifications.set(providerId, active);
        const timeout = setTimeout(
            () => controller.abort(new Error("Provider verification timed out.")),
            VERIFICATION_TIMEOUT_MS,
        );
        timeout.unref();

        let performedLevel = requestedLevel;
        let modelId: string | null = null;
        let passed = false;
        try {
            const credentials = await this.#probe(providerId);
            if (requestedLevel === "credentials") {
                passed = credentials === "available";
            } else if (credentials === "available" && requestedLevel === "authentication") {
                try {
                    const usage = await this.#config.readProviderUsageUnchecked(
                        verificationContext(ctx, controller.signal),
                        providerId,
                    );
                    if (usage === null) {
                        performedLevel = "inference";
                        const inference = await this.#verifyInference(
                            ctx,
                            providerId,
                            controller.signal,
                        );
                        modelId = inference.modelId;
                        passed = inference.passed;
                    } else {
                        passed = true;
                    }
                } catch {
                    passed = false;
                }
            } else if (credentials === "available" && requestedLevel === "inference") {
                const inference = await this.#verifyInference(ctx, providerId, controller.signal);
                modelId = inference.modelId;
                passed = inference.passed;
            }
        } catch {
            passed = false;
        } finally {
            clearTimeout(timeout);
            active.delete(controller);
            if (active.size === 0) this.#verifications.delete(providerId);
        }

        if (passed) await this.#remember(ctx, providerId);
        return {
            checkedAt: Date.now(),
            modelId,
            performedLevel,
            providerId,
            requestedLevel,
            status: passed ? "passed" : "failed",
        };
    }

    #assertProvider(providerId: string): void {
        if (!this.#config.providerIds.includes(providerId)) {
            throw new ProviderNotFoundError(providerId);
        }
    }

    async #load(ctx: Context): Promise<void> {
        if (this.#loaded) return;
        await this.#lock.runInLock(ctx, async () => {
            if (this.#loaded) return;
            const state = await readState(this.#config.configuration.paths.providerStatePath);
            if (state !== null) {
                for (const providerId of state.remembered) {
                    if (this.#config.providerIds.includes(providerId)) {
                        this.#remembered.add(providerId);
                    }
                }
                for (const [providerId, enabled] of Object.entries(state.overrides)) {
                    if (this.#config.providerIds.includes(providerId)) {
                        this.#overrides.set(providerId, enabled);
                    }
                }
            }
            // Automatic discoveries remain off until this process completes its startup scan.
            for (const providerId of this.#config.providerIds) {
                this.#config.setProviderEnabled(providerId, this.#explicit(providerId) ?? false);
            }
            this.#loaded = true;
        });
    }

    async #performScan(ctx: Context): Promise<ProviderScanResponse> {
        const outcomes = await Promise.all(
            [...this.#config.providerIds]
                .sort((left, right) => left.localeCompare(right))
                .map(async (providerId) => ({
                    credentials: await this.#probe(providerId),
                    providerId,
                })),
        );
        return await this.#lock.runInLock(ctx, async () => {
            const nextRemembered = new Set(this.#remembered);
            let changed = false;
            for (const outcome of outcomes) {
                if (outcome.credentials !== "available" || nextRemembered.has(outcome.providerId)) {
                    continue;
                }
                nextRemembered.add(outcome.providerId);
                changed = true;
            }
            if (changed) await this.#writeState(this.#overrides, nextRemembered);
            replaceSet(this.#remembered, nextRemembered);
            for (const providerId of this.#config.providerIds) this.#applyEffective(providerId);
            const providers = outcomes.map(({ credentials, providerId }) =>
                this.#scanResult(providerId, credentials),
            );
            return { completedAt: Date.now(), providers };
        });
    }

    async #probe(providerId: string): Promise<ProviderCredentialStatus> {
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.#config.probeLocalProviderCredentials(providerId),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error("Provider credential discovery timed out.")),
                        PROVIDER_PROBE_TIMEOUT_MS,
                    );
                    timeout.unref();
                }),
            ]);
        } catch {
            return "error";
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }

    #scanResult(providerId: string, credentials: ProviderCredentialStatus): ProviderScanResult {
        const explicit = this.#explicit(providerId);
        const remembered = this.#remembered.has(providerId);
        return {
            credentials,
            enabled: this.#config.isProviderEnabled(providerId),
            enablement: explicit !== undefined ? "explicit" : remembered ? "scan" : "default",
            providerId,
            remembered,
        };
    }

    #explicit(providerId: string): boolean | undefined {
        return (
            this.#overrides.get(providerId) ?? this.#config.configuredProviderOverride(providerId)
        );
    }

    #applyEffective(providerId: string): void {
        this.#config.setProviderEnabled(
            providerId,
            this.#explicit(providerId) ?? this.#remembered.has(providerId),
        );
    }

    async #remember(ctx: Context, providerId: string): Promise<void> {
        await this.#lock.runInLock(ctx, async () => {
            if (!this.#remembered.has(providerId)) {
                const nextRemembered = new Set(this.#remembered).add(providerId);
                await this.#writeState(this.#overrides, nextRemembered);
                replaceSet(this.#remembered, nextRemembered);
            }
            this.#applyEffective(providerId);
        });
    }

    async #verifyInference(
        ctx: Context,
        providerId: string,
        signal: AbortSignal,
    ): Promise<{ readonly modelId: string | null; readonly passed: boolean }> {
        const model = verificationModel(this.#config.offeredModels, providerId);
        if (model === undefined) return { modelId: null, passed: false };
        let session: BaseSession | undefined;
        try {
            const provider = await Promise.race([
                this.#config.resolveProviderUnchecked(providerId, model.id),
                rejectWhenAborted(signal),
            ]);
            if (provider === null) return { modelId: model.id, passed: false };
            session = await Promise.race([
                provider.session(`provider-verification:${createId()}`, {
                    inferenceMaxRetries: 0,
                    instructions: "Reply with OK.",
                    tools: [],
                }),
                rejectWhenAborted(signal),
            ]);
            const runCtx = verificationContext(ctx, signal);
            const consume = async (): Promise<boolean> => {
                for await (const event of session!.run(runCtx, {
                    context: {
                        instructions: "Reply with OK.",
                        messages: [
                            { role: "user", content: [{ type: "text", text: "Reply with OK." }] },
                        ],
                    },
                    effort: verificationEffort(model),
                    model: model.id,
                })) {
                    if (event.type === "done") return event.state === "normal";
                }
                return false;
            };
            return {
                modelId: model.id,
                passed: await Promise.race([consume(), rejectWhenAborted(signal)]),
            };
        } catch {
            return { modelId: model.id, passed: false };
        } finally {
            if (session !== undefined) {
                await Promise.resolve(session.destroy()).catch(() => undefined);
            }
        }
    }

    #abortVerifications(providerId: string): void {
        for (const controller of this.#verifications.get(providerId) ?? []) {
            controller.abort(new Error(`Provider "${providerId}" was disabled.`));
        }
    }

    async #writeState(
        overrides: ReadonlyMap<string, boolean>,
        remembered: ReadonlySet<string>,
    ): Promise<void> {
        await writeState(this.#config.configuration.paths.providerStatePath, {
            overrides: Object.fromEntries(
                [...overrides].sort(([left], [right]) => left.localeCompare(right)),
            ),
            remembered: [...remembered].sort((left, right) => left.localeCompare(right)),
            version: 1,
        });
    }
}

export class ProviderNotFoundError extends Error {
    constructor(providerId: string) {
        super(`Provider "${providerId}" is not configured.`);
        this.name = "ProviderNotFoundError";
    }
}

function verificationModel(
    models: readonly AgentModel[],
    providerId: string,
): AgentModel | undefined {
    const preferred: Readonly<Record<string, string>> = {
        bedrock: "anthropic/fable-5",
        claude: "anthropic/fable-5",
        codex: "openai/gpt-5.6-luna",
        grok: "xai/grok-composer-2.5-fast",
    };
    const routes = models.filter((model) => model.providerId === providerId);
    return routes.find((model) => model.id === preferred[providerId]) ?? routes[0];
}

function verificationEffort(model: AgentModel): SessionReasoningEffort {
    return model.effortLevels[0] ?? "low";
}

function verificationContext(ctx: Context, signal: AbortSignal): Context {
    const lifetime = ctx.lifetime === undefined ? signal : AbortSignal.any([ctx.lifetime, signal]);
    return withLifetime(ctx, lifetime);
}

function scanOwnerContext(ctx: Context): Context {
    const owner = detach(ctx).named("provider-scan");
    return ctx.lifetime === undefined ? owner : withLifetime(owner, ctx.lifetime);
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        const fail = () =>
            reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled."));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
    });
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
}

function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
    target.clear();
    for (const value of source) target.add(value);
}

async function readState(path: string): Promise<ProviderState | null> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(path, "r");
        if ((await file.stat()).size > MAX_STATE_BYTES) return null;
        const value = JSON.parse(await file.readFile("utf8")) as unknown;
        return Value.Check(providerStateSchema, value) ? value : null;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return null;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

async function writeState(path: string, state: ProviderState): Promise<void> {
    if (!Value.Check(providerStateSchema, state)) {
        throw new Error("The provider scan state is invalid.");
    }
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${createId()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}
