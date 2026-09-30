import { statSync } from "node:fs";
import type { AgentModel } from "@slopus/happy-agent-base";
import { CodexProvider, CodexSessionCredential, type BaseProvider } from "@slopus/happy-providers";

const CACHE_LIFETIME_MS = 5 * 60_000;

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

    apply<T extends AgentModel>(model: T): T {
        return this.#current(model.providerId)?.ultrafastModels.has(model.id)
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
            const tiers = await provider.modelServiceTiers(models, { signal });
            if (
                signal.aborted ||
                key !== (await provider.serviceTierAccountKey()) ||
                identity !== fileIdentity(authFile)
            ) {
                this.clear(providerId);
                return;
            }
            const ultrafastModels = new Set(
                models.filter((model) => tiers[model]?.includes("ultrafast")),
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

    async validate(
        providerId: string,
        model: string | undefined,
        provider?: BaseProvider,
    ): Promise<void> {
        const current = this.#current(providerId);
        if (current !== undefined && model !== undefined && current.ultrafastModels.has(model)) {
            try {
                // Concrete providers are reconstructed by the registry. A previously opened
                // session may still belong to an old account even after the cache refreshed.
                const actual = provider ?? current.provider;
                if (
                    actual instanceof CodexProvider &&
                    (await actual.serviceTierAccountKey()) === current.accountKey &&
                    this.#current(providerId) === current
                )
                    return;
            } catch {
                // A missing or unreadable credential is not evidence of eligibility.
            }
            this.clear(providerId);
        }
        throw new Error(
            "Ultrafast is unavailable for this account and model. Choose Regular or Fast and try again.",
        );
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
