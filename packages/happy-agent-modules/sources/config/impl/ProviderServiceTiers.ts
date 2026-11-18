import { statSync } from "node:fs";
import type { AgentModel } from "@slopus/happy-agent-base";
import { CodexProvider, CodexSessionCredential, type BaseProvider } from "@slopus/happy-providers";
import { readCodexPlanType } from "./readCodexPlanType.js";

const CACHE_LIFETIME_MS = 5 * 60_000;

/**
 * Ultrafast models OpenAI offers on a ChatGPT plan even when that account's remote catalog does
 * not list them. Merged with the remote answer; a login whose plan cannot be read gets none.
 */
const PLAN_ULTRAFAST_MODELS: Readonly<Record<string, readonly string[]>> = {
    pro: ["openai/gpt-6.2-sol"],
};

interface AccountTiers {
    readonly provider: CodexProvider;
    readonly accountKey: string;
    readonly authFile: string;
    readonly fileIdentity: string;
    readonly expiresAt: number;
    readonly refreshAfter: number;
    readonly ultrafastModels: ReadonlySet<string>;
}

/** Ephemeral account capabilities, never a source of model identities or Regular/Fast policy. */
export class ProviderServiceTiers {
    readonly #accounts = new Map<string, AccountTiers>();
    readonly #changed: () => void;

    constructor(changed: () => void) {
        this.#changed = changed;
    }

    clear(providerId?: string): void {
        const changed =
            providerId === undefined
                ? [...this.#accounts.values()].some((account) => account.ultrafastModels.size > 0)
                : (this.#accounts.get(providerId)?.ultrafastModels.size ?? 0) > 0;
        if (providerId === undefined) this.#accounts.clear();
        else this.#accounts.delete(providerId);
        if (changed) this.#changed();
    }

    /**
     * `members` names the enabled accounts a smart route may send this model to; the route offers
     * Ultrafast only when every one of them does.
     */
    apply<T extends AgentModel>(model: T, members?: readonly string[]): T {
        const eligible =
            members === undefined
                ? this.#current(model.providerId)?.ultrafastModels.has(model.id) === true
                : members.length > 0 &&
                  members.every((member) => this.#current(member)?.ultrafastModels.has(model.id));
        return eligible
            ? { ...model, serviceTiers: [...new Set([...(model.serviceTiers ?? []), "ultrafast"])] }
            : model;
    }

    async refresh(
        providerId: string,
        provider: CodexProvider,
        models: readonly string[],
        signal: AbortSignal,
    ): Promise<void> {
        try {
            const key = await provider.serviceTierAccountKey();
            const current = this.#current(providerId);
            const sameAccount = key !== null && current?.accountKey === key;
            if (sameAccount && Date.now() < current.refreshAfter) return;
            if (!sameAccount) this.clear(providerId);
            if (
                key === null ||
                signal.aborted ||
                !(provider.credential instanceof CodexSessionCredential)
            )
                return;
            const authFile = provider.credential.authFile;
            const identity = fileIdentity(authFile);
            if (identity === undefined) {
                this.clear(providerId);
                return;
            }
            const [tiers, plan] = await Promise.all([
                provider.modelServiceTiers(models, { signal }),
                readCodexPlanType(authFile),
            ]);
            if (
                signal.aborted ||
                key !== (await provider.serviceTierAccountKey()) ||
                identity !== fileIdentity(authFile)
            ) {
                this.clear(providerId);
                return;
            }
            const planModels = plan === undefined ? [] : (PLAN_ULTRAFAST_MODELS[plan] ?? []);
            const ultrafastModels = new Set(
                models.filter(
                    (model) => tiers[model]?.includes("ultrafast") || planModels.includes(model),
                ),
            );
            this.#accounts.set(providerId, {
                provider,
                accountKey: key,
                authFile,
                fileIdentity: identity,
                expiresAt: Date.now() + CACHE_LIFETIME_MS,
                refreshAfter: Date.now() + CACHE_LIFETIME_MS - 60_000,
                ultrafastModels,
            });
            if (
                !sameAccount
                    ? ultrafastModels.size > 0
                    : current.ultrafastModels.size !== ultrafastModels.size ||
                      [...ultrafastModels].some((model) => !current.ultrafastModels.has(model))
            )
                this.#changed();
        } catch {
            // Authentication/catalog diagnostics may contain secrets. Unknown eligibility is
            // simply unavailable; it never removes ordinary inference or disables an account.
            this.clear(providerId);
        }
    }

    /**
     * `members` names the enabled accounts a smart route may send this model to. The router picks
     * one later, so each must still hold its own eligible login.
     */
    async validate(
        providerId: string,
        model: string | undefined,
        provider?: BaseProvider,
        members?: readonly string[],
    ): Promise<void> {
        const eligible =
            members === undefined
                ? await this.#eligible(providerId, model, provider)
                : members.length > 0 &&
                  (
                      await Promise.all(
                          members.map(async (member) => await this.#eligible(member, model)),
                      )
                  ).every(Boolean);
        if (eligible) return;
        throw new Error(
            "Ultrafast is unavailable for this account and model. Choose Regular or Fast and try again.",
        );
    }

    async #eligible(
        providerId: string,
        model: string | undefined,
        provider?: BaseProvider,
    ): Promise<boolean> {
        const current = this.#current(providerId);
        if (current === undefined || model === undefined || !current.ultrafastModels.has(model))
            return false;
        try {
            // Concrete providers are reconstructed by the registry. A previously opened
            // session may still belong to an old account even after the cache refreshed.
            const actual = provider ?? current.provider;
            if (
                actual instanceof CodexProvider &&
                (await actual.serviceTierAccountKey()) === current.accountKey &&
                this.#current(providerId) === current
            )
                return true;
        } catch {
            // A missing or unreadable credential is not evidence of eligibility.
        }
        this.clear(providerId);
        return false;
    }

    #current(providerId: string): AccountTiers | undefined {
        const current = this.#accounts.get(providerId);
        if (
            current !== undefined &&
            (Date.now() >= current.expiresAt ||
                fileIdentity(current.authFile) !== current.fileIdentity)
        ) {
            this.clear(providerId);
            return undefined;
        }
        return current;
    }
}

/** Synchronous metadata invalidates cached UI capabilities on replacement, rotation, or removal. */
function fileIdentity(path: string): string | undefined {
    try {
        const stat = statSync(path, { bigint: true });
        return stat.isFile()
            ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
            : undefined;
    } catch {
        return undefined;
    }
}
