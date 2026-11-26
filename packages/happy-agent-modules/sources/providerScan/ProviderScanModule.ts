import { createId } from "@paralleldrive/cuid2";
import type {
    ProviderCredentialStatus,
    ProviderScanResponse,
    ProviderScanResult,
    ProviderVerificationLevel,
    ProviderVerificationResponse,
} from "@slopus/happy-agent-client";
import type { AgentModel, AgentModule } from "@slopus/happy-agent-base";
import type { BaseSession } from "@slopus/happy-providers";
import { asyncLock, detach, withLifetime, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import {
    describeVerificationFailure,
    isModelSpecificFailure,
    verificationProblemReason,
    type VerificationProblem,
    type VerificationTarget,
} from "./describeVerificationFailure.js";
import { verificationCandidates, verificationEffort } from "./verificationCandidates.js";

const PROVIDER_PROBE_TIMEOUT_MS = 10_000;
/** One budget for the whole check, every model attempt included, well inside the desktop's 60s. */
const VERIFICATION_TIMEOUT_MS = 30_000;
/** Models tried before giving up; only a model-specific failure moves on to the next one. */
const MAX_INFERENCE_ATTEMPTS = 3;
/**
 * A further model is tried only with at least this much of the budget left, because a probe cut
 * short would replace a clear model-specific failure with a vague timeout.
 */
const MIN_ATTEMPT_BUDGET_MS = 5_000;

/** Owns provider discovery, durable user overrides, and bounded account verification. */
export class ProviderScanModule implements AgentModule {
    readonly name = "provider-scan";

    readonly #config: ConfigModule;
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #remembered = new Set<string>();
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

    /** Do not let a scan that already read the old credentials stand in for the new ones. */
    async scanAfterCredentialChange(ctx: Context): Promise<ProviderScanResponse> {
        if (this.#scanPromise !== undefined) await this.#scanPromise;
        return await this.scan(ctx);
    }

    /**
     * Count a sign-in the local scan cannot see, such as Antigravity's own login that the provider
     * CLIs check, as a discovery: the account is remembered and enabled under the scan's rules.
     */
    async recordDiscovery(ctx: Context, providerId: string): Promise<void> {
        await this.#load(ctx);
        this.#assertProvider(providerId);
        await this.#remember(ctx, providerId);
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
            await this.#config.updateRuntimeProviderStates(
                ctx,
                Object.fromEntries(
                    changes.map(([providerId, value]) => [providerId, { enabled: value.enabled }]),
                ),
            );
            for (const [providerId, value] of changes) {
                this.#config.setProviderEnabled(providerId, value.enabled);
                if (!value.enabled) this.#abortVerifications(providerId);
            }
        });
    }

    /** Verify one configured provider, explaining a failure with a sanitized diagnostic. */
    async verify(
        ctx: Context,
        providerId: string,
        requestedLevel: ProviderVerificationLevel,
    ): Promise<ProviderVerificationResponse> {
        await this.#load(ctx);
        this.#assertProvider(providerId);
        const deadline = Date.now() + VERIFICATION_TIMEOUT_MS;
        const controller = new AbortController();
        const active = this.#verifications.get(providerId) ?? new Set<AbortController>();
        active.add(controller);
        this.#verifications.set(providerId, active);
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("Provider verification timed out."));
        }, VERIFICATION_TIMEOUT_MS);
        timeout.unref();

        let performedLevel = requestedLevel;
        let modelId: string | null = null;
        let triedModelIds: readonly string[] = [];
        let passed = false;
        let problem: VerificationProblem | undefined;
        try {
            const credentials = await this.#probe(providerId);
            if (credentials !== "available") {
                problem = { type: "credentials", status: credentials };
            }
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
                            deadline,
                        );
                        modelId = inference.modelId;
                        triedModelIds = inference.triedModelIds;
                        passed = inference.passed;
                        problem = inference.problem;
                    } else {
                        passed = true;
                    }
                } catch (error) {
                    passed = false;
                    problem = { type: "account_check", error };
                }
            } else if (credentials === "available" && requestedLevel === "inference") {
                const inference = await this.#verifyInference(
                    ctx,
                    providerId,
                    controller.signal,
                    deadline,
                );
                modelId = inference.modelId;
                triedModelIds = inference.triedModelIds;
                passed = inference.passed;
                problem = inference.problem;
            }
        } catch (error) {
            passed = false;
            problem = { type: "thrown", error };
        } finally {
            clearTimeout(timeout);
            active.delete(controller);
            if (active.size === 0) this.#verifications.delete(providerId);
        }

        if (passed) {
            await this.#remember(ctx, providerId);
            return {
                checkedAt: Date.now(),
                modelId,
                performedLevel,
                providerId,
                requestedLevel,
                status: "passed",
            };
        }
        if (timedOut) {
            problem = { type: "timeout", seconds: VERIFICATION_TIMEOUT_MS / 1_000 };
        } else if (controller.signal.aborted) {
            problem = { type: "aborted" };
        }
        // The daemon log keeps the unsanitized reason for support; the response carries only the
        // classified, sanitized failure.
        ctx.log.warn("Provider verification failed.", {
            providerId,
            requestedLevel,
            performedLevel,
            modelId,
            ...(triedModelIds.length > 1 ? { triedModelIds } : {}),
            reason:
                problem === undefined
                    ? "The check did not pass."
                    : verificationProblemReason(problem),
        });
        return {
            checkedAt: Date.now(),
            failure: describeVerificationFailure(
                { ...this.#verificationTarget(providerId, modelId), triedModelIds },
                problem ?? { type: "incomplete", state: null },
            ),
            modelId,
            performedLevel,
            providerId,
            requestedLevel,
            status: "failed",
        };
    }

    /** Non-secret provider facts for failure messages: names, hosts, and regions only. */
    #verificationTarget(providerId: string, modelId: string | null): VerificationTarget {
        const type = this.#config.providers.typeOf(providerId);
        const configured = this.#config.configuration.values.providers[providerId];
        const host =
            configured !== undefined && "baseUrl" in configured
                ? hostOf(configured.baseUrl)
                : undefined;
        return {
            label:
                configured?.name ??
                providerLabel(type ?? configured?.type ?? null, providerId, host),
            modelId,
            type: type ?? configured?.type ?? null,
            ...(host === undefined ? {} : { host }),
            ...(configured?.type === "bedrock"
                ? {
                      ...(configured.region === undefined ? {} : { region: configured.region }),
                      ...(configured.profile === undefined
                          ? {}
                          : { awsProfile: configured.profile }),
                      ...(configured.bearerTokenEnvVar === undefined
                          ? {}
                          : { credentialEnvVar: configured.bearerTokenEnvVar }),
                  }
                : {}),
            ...(configured?.type === "openai_compatible" && configured.apiKeyEnv !== undefined
                ? { credentialEnvVar: configured.apiKeyEnv }
                : {}),
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
            // Automatic discoveries remain off until this process completes its startup scan.
            for (const providerId of this.#config.providerIds) {
                if (this.#config.providerAutoEnable(providerId) === true) {
                    this.#remembered.add(providerId);
                }
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
            const updates: Record<string, { readonly autoEnable: true }> = {};
            for (const outcome of outcomes) {
                if (outcome.credentials !== "available" || nextRemembered.has(outcome.providerId)) {
                    continue;
                }
                // `auto_enable = false` is a durable human decision. Only a provider without an
                // auto-enable setting receives the true default on first detection.
                if (this.#config.providerAutoEnable(outcome.providerId) !== undefined) continue;
                nextRemembered.add(outcome.providerId);
                updates[outcome.providerId] = { autoEnable: true };
            }
            if (Object.keys(updates).length > 0) {
                await this.#config.updateRuntimeProviderStates(ctx, updates);
            }
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
        const autoEnable = this.#config.providerAutoEnable(providerId);
        const remembered = this.#remembered.has(providerId);
        return {
            credentials,
            enabled: this.#config.isProviderEnabled(providerId),
            enablement:
                explicit !== undefined || autoEnable === false
                    ? "explicit"
                    : remembered
                      ? "scan"
                      : "default",
            providerId,
            remembered,
        };
    }

    #explicit(providerId: string): boolean | undefined {
        return this.#config.configuredProviderOverride(providerId);
    }

    #applyEffective(providerId: string): void {
        this.#config.setProviderEnabled(
            providerId,
            this.#explicit(providerId) ?? this.#config.providerAutoEnable(providerId) === true,
        );
    }

    async #remember(ctx: Context, providerId: string): Promise<void> {
        await this.#lock.runInLock(ctx, async () => {
            if (
                !this.#remembered.has(providerId) &&
                this.#config.providerAutoEnable(providerId) !== false
            ) {
                await this.#config.updateRuntimeProviderStates(ctx, {
                    [providerId]: { autoEnable: true },
                });
                this.#remembered.add(providerId);
            }
            this.#applyEffective(providerId);
        });
    }

    /**
     * Tries the provider's models cheapest first and stops at the first that answers. Only a
     * model-specific failure moves on to the next model; anything that would fail for every model
     * stops at once, so a broken sign-in or network costs one request.
     */
    async #verifyInference(
        ctx: Context,
        providerId: string,
        signal: AbortSignal,
        deadline: number,
    ): Promise<{
        readonly modelId: string | null;
        readonly passed: boolean;
        readonly problem?: VerificationProblem;
        readonly triedModelIds: readonly string[];
    }> {
        const { candidates, onlyFable } = verificationCandidates(
            this.#config.offeredModels,
            providerId,
        );
        if (candidates.length === 0) {
            return {
                modelId: null,
                passed: false,
                problem: { type: "no_model", ...(onlyFable ? { onlyFable } : {}) },
                triedModelIds: [],
            };
        }
        const tried: string[] = [];
        const failed: { readonly modelName: string; readonly problem: VerificationProblem }[] = [];
        for (const model of candidates.slice(0, MAX_INFERENCE_ATTEMPTS)) {
            if (tried.length > 0 && deadline - Date.now() < MIN_ATTEMPT_BUDGET_MS) break;
            tried.push(model.id);
            const attempt = await this.#attemptInference(ctx, providerId, model, signal);
            if (attempt === undefined) {
                return { modelId: model.id, passed: true, triedModelIds: tried };
            }
            if (
                signal.aborted ||
                !isModelSpecificFailure(this.#verificationTarget(providerId, model.id), attempt)
            ) {
                // A failure every model would share explains itself.
                return { modelId: model.id, passed: false, problem: attempt, triedModelIds: tried };
            }
            failed.push({ modelName: model.name, problem: attempt });
        }
        return {
            modelId: tried.at(-1) ?? null,
            passed: false,
            problem: { type: "models_failed", attempts: failed },
            triedModelIds: tried,
        };
    }

    /** One minimal no-tool request; `undefined` means the model answered. */
    async #attemptInference(
        ctx: Context,
        providerId: string,
        model: AgentModel,
        signal: AbortSignal,
    ): Promise<VerificationProblem | undefined> {
        let session: BaseSession | undefined;
        try {
            const provider = await Promise.race([
                this.#config.resolveProviderUnchecked(providerId, model.id),
                rejectWhenAborted(signal),
            ]);
            if (provider === null) return { type: "unprepared" };
            session = await Promise.race([
                provider.session(`provider-verification:${createId()}`, {
                    inferenceMaxRetries: 0,
                    instructions: "Reply with OK.",
                    tools: [],
                }),
                rejectWhenAborted(signal),
            ]);
            const runCtx = verificationContext(ctx, signal);
            const consume = async (): Promise<VerificationProblem | undefined> => {
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
                    if (event.type !== "done") continue;
                    if (event.state === "normal") return undefined;
                    return event.state === "error"
                        ? {
                              type: "session_error",
                              kind: event.kind,
                              message: event.message,
                              ...(event.providerError === undefined
                                  ? {}
                                  : { providerError: event.providerError }),
                          }
                        : { type: "incomplete", state: event.state };
                }
                return { type: "incomplete", state: null };
            };
            return await Promise.race([consume(), rejectWhenAborted(signal)]);
        } catch (error) {
            return { type: "thrown", error };
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
}

export class ProviderNotFoundError extends Error {
    constructor(providerId: string) {
        super(`Provider "${providerId}" is not configured.`);
        this.name = "ProviderNotFoundError";
    }
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

function providerLabel(type: string | null, providerId: string, host: string | undefined): string {
    const labels: Readonly<Record<string, string>> = {
        bedrock: "Amazon Bedrock",
        claude: "Claude",
        codex: "Codex",
        grok: "Grok",
        openai_compatible: host ?? "The OpenAI-compatible endpoint",
    };
    return labels[type ?? providerId] ?? `Provider "${providerId}"`;
}

function hostOf(url: string | undefined): string | undefined {
    if (url === undefined) return undefined;
    try {
        return new URL(url).host || undefined;
    } catch {
        return undefined;
    }
}

function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
    target.clear();
    for (const value of source) target.add(value);
}
