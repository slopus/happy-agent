import type { ProviderQuota, ProviderUsage } from "@slopus/happy-providers";

import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import type { OwnerProviderScope } from "../credentials/buildOwnerProviderScope.js";
import type { ProviderCredentialProvenance, ProviderUsageEntry } from "../protocol/index.js";
import {
    createProviderQuotaService,
    type ProviderQuotaService,
} from "./createProviderQuotaService.js";
import {
    createProviderUsageService,
    type ProviderUsageService,
} from "./createProviderUsageService.js";
import { loadConfiguredProviderUsage } from "./loadConfiguredProviderUsage.js";

interface CredentialBinding {
    credential: ProviderCredentialProvenance;
    provider: ConfigProvider;
}

export interface CredentialBindingUsageRouter {
    clearProvisionedCaches(): void;
    entry(ownerInstanceId: string, providerId: string): Promise<ProviderUsageEntry>;
    quota(
        ownerInstanceId: string,
        providerId: string,
        credential?: ProviderCredentialProvenance,
    ): Promise<ProviderQuota | undefined>;
    record(ownerInstanceId: string, usage: ProviderUsage): ProviderUsage;
}

export interface CreateCredentialBindingUsageRouterOptions {
    localInstanceId: string;
    localProviders: ConfigProviders;
    localQuotaService: ProviderQuotaService;
    localUsageService: ProviderUsageService;
    now?: () => number;
    observeLocalUsage?: (usage: ProviderUsage) => void;
    resolveScope: (ownerInstanceId: string) => OwnerProviderScope | undefined;
}

/**
 * Routes account usage through the credential that backs the selected catalog provider.
 *
 * A session owner is not necessarily the credential owner: owner-scoped catalogs can append a
 * shared provider from another Rig under a namespaced effective ID. Vendor usage is cached by the
 * stable credential binding, while responses keep the provider ID selected by the session.
 */
export function createCredentialBindingUsageRouter(
    options: CreateCredentialBindingUsageRouterOptions,
): CredentialBindingUsageRouter {
    const usageServices = new Map<string, ProviderUsageService>();
    const quotaServices = new Map<string, ProviderQuotaService>();
    const now = options.now ?? Date.now;

    const resolveBinding = (
        ownerInstanceId: string,
        providerId: string,
        credentialHint?: ProviderCredentialProvenance,
    ): CredentialBinding | undefined => {
        const scope = options.resolveScope(ownerInstanceId);
        if (scope === undefined) {
            const provider = options.localProviders[providerId];
            if (provider === undefined) return undefined;
            return {
                credential: {
                    bindingId: `${options.localInstanceId}:${providerId}`,
                    ownerInstanceId: options.localInstanceId,
                    ownerName: options.localInstanceId,
                    relation: "owner",
                    sourceProviderId: providerId,
                    visibility: provider.p2pShare === "shared" ? "shared" : "owner_only",
                },
                provider,
            };
        }
        let effectiveProviderId = providerId;
        let credential = scope.providerBindings.get(effectiveProviderId);
        if (credentialHint !== undefined && credential?.bindingId !== credentialHint.bindingId) {
            const matching = [...scope.providerBindings].find(
                ([, candidate]) => candidate.bindingId === credentialHint.bindingId,
            );
            if (matching === undefined) return undefined;
            effectiveProviderId = matching[0];
            credential = matching[1];
        }
        const provider = scope.providers[effectiveProviderId];
        return credential === undefined || provider === undefined
            ? undefined
            : { credential, provider };
    };

    const usageFor = (binding: CredentialBinding): ProviderUsageService => {
        if (binding.credential.ownerInstanceId === options.localInstanceId) {
            return options.localUsageService;
        }
        let service = usageServices.get(binding.credential.bindingId);
        if (service !== undefined) return service;
        const providerId = binding.credential.sourceProviderId;
        const providers = { [providerId]: binding.provider };
        service = createProviderUsageService({
            loadUsage: (candidateProviderId) =>
                loadConfiguredProviderUsage({ providerId: candidateProviderId, providers }),
        });
        usageServices.set(binding.credential.bindingId, service);
        return service;
    };

    const quotaFor = (binding: CredentialBinding): ProviderQuotaService => {
        if (binding.credential.ownerInstanceId === options.localInstanceId) {
            return options.localQuotaService;
        }
        let service = quotaServices.get(binding.credential.bindingId);
        if (service !== undefined) return service;
        const providerId = binding.credential.sourceProviderId;
        const providers = { [providerId]: binding.provider };
        const usage = usageFor(binding);
        service = createProviderQuotaService({
            loadClaudeUsage: (candidateProviderId) => usage.get(candidateProviderId),
            providers,
        });
        quotaServices.set(binding.credential.bindingId, service);
        return service;
    };

    return {
        clearProvisionedCaches() {
            quotaServices.clear();
            usageServices.clear();
        },
        async entry(ownerInstanceId, providerId) {
            const binding = resolveBinding(ownerInstanceId, providerId);
            if (binding === undefined) {
                return {
                    checkedAt: now(),
                    error: "The provider credential is no longer available.",
                    providerId,
                    usage: null,
                };
            }
            try {
                const usage = await usageFor(binding).get(binding.credential.sourceProviderId);
                return {
                    checkedAt: now(),
                    credential: binding.credential,
                    error: null,
                    providerId,
                    usage: usage === null ? null : { ...usage, providerId },
                };
            } catch (error) {
                return {
                    checkedAt: now(),
                    credential: binding.credential,
                    error: error instanceof Error ? error.message : String(error),
                    providerId,
                    usage: null,
                };
            }
        },
        quota(ownerInstanceId, providerId, credential) {
            const binding = resolveBinding(ownerInstanceId, providerId, credential);
            return binding === undefined
                ? Promise.resolve(undefined)
                : quotaFor(binding).get(binding.credential.sourceProviderId);
        },
        record(ownerInstanceId, usage) {
            const binding = resolveBinding(ownerInstanceId, usage.providerId);
            if (binding === undefined) return usage;
            const canonical = {
                ...usage,
                providerId: binding.credential.sourceProviderId,
            };
            const merged = usageFor(binding).record(canonical);
            if (binding.credential.ownerInstanceId === options.localInstanceId) {
                options.observeLocalUsage?.(merged);
            }
            return { ...merged, providerId: usage.providerId };
        },
    };
}
