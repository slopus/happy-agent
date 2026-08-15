import type { ProviderQuota, ProviderUsage } from "@slopus/happy-providers";
import { describe, expect, it, vi } from "vitest";

import type { OwnerProviderScope } from "../credentials/buildOwnerProviderScope.js";
import { createCredentialBindingUsageRouter } from "./createCredentialBindingUsageRouter.js";

const remoteCredential = {
    bindingId: "remote-rig:codex",
    ownerInstanceId: "remote-rig",
    ownerName: "Remote Rig",
    relation: "extra" as const,
    sourceProviderId: "codex",
    visibility: "shared" as const,
};

describe("createCredentialBindingUsageRouter", () => {
    it("reads a shared extra from its credential binding instead of the session owner", async () => {
        const localGet = vi.fn(async () => localUsage("codex", 15));
        const localQuotaGet = vi.fn(async () => localQuota(15));
        const scope = ownerScope();
        const router = createCredentialBindingUsageRouter({
            localInstanceId: "local-rig",
            localProviders: {
                codex: { apiKey: "local-key", enabled: true, type: "codex" },
            },
            localQuotaService: { get: localQuotaGet },
            localUsageService: { get: localGet, record: (usage) => usage },
            now: () => 100,
            resolveScope: () => scope,
        });

        await expect(router.entry("local-rig", "codex@remote-rig")).resolves.toEqual({
            checkedAt: 100,
            credential: remoteCredential,
            error: null,
            providerId: "codex@remote-rig",
            usage: null,
        });
        const quota = await router.quota("local-rig", "codex@remote-rig", remoteCredential);

        expect(localGet).not.toHaveBeenCalled();
        expect(localQuotaGet).not.toHaveBeenCalled();
        expect(quota).toMatchObject({
            source: "codex",
            windows: {
                fiveHour: { status: "unavailable" },
                weekly: { status: "unavailable" },
            },
        });

        await expect(
            router.quota("local-rig", "codex@remote-rig", {
                ...remoteCredential,
                bindingId: "revoked-rig:codex",
            }),
        ).resolves.toBeUndefined();
        expect(localQuotaGet).not.toHaveBeenCalled();
    });

    it("maps volunteered usage back to the session-visible provider ID", () => {
        const localRecord = vi.fn((usage: ProviderUsage) => ({
            ...usage,
            planName: "Local plan",
        }));
        const observeLocalUsage = vi.fn();
        const scope = ownerScope({
            bindingId: "local-rig:codex",
            ownerInstanceId: "local-rig",
            ownerName: "Local Rig",
            relation: "extra",
            sourceProviderId: "codex",
            visibility: "shared",
        });
        const router = createCredentialBindingUsageRouter({
            localInstanceId: "local-rig",
            localProviders: {
                codex: { apiKey: "local-key", enabled: true, type: "codex" },
            },
            localQuotaService: { get: async () => undefined },
            localUsageService: { get: async () => null, record: localRecord },
            observeLocalUsage,
            resolveScope: () => scope,
        });

        expect(
            router.record("remote-session-owner", localUsage("codex@remote-rig", 42)),
        ).toMatchObject({
            planName: "Local plan",
            providerId: "codex@remote-rig",
        });
        expect(localRecord).toHaveBeenCalledWith(expect.objectContaining({ providerId: "codex" }));
        expect(observeLocalUsage).toHaveBeenCalledWith(
            expect.objectContaining({ providerId: "codex" }),
        );
    });
});

function ownerScope(credential: typeof remoteCredential = remoteCredential): OwnerProviderScope {
    return {
        catalog: {
            defaultModelId: "model",
            defaultProviderId: "codex@remote-rig",
            models: [],
            providers: [],
        },
        providerBindings: new Map([["codex@remote-rig", credential]]),
        providers: {
            "codex@remote-rig": {
                apiKey: "remote-key",
                credentialIsolation: true,
                enabled: true,
                type: "codex",
            },
        },
    };
}

function localUsage(providerId: string, usedPercent: number): ProviderUsage {
    return {
        capturedAt: 10,
        credits: null,
        exhausted: false,
        planName: null,
        providerId,
        vendor: "codex",
        windows: {
            fiveHour: {
                durationMs: null,
                resetsAt: 20,
                startsAt: null,
                usedPercent,
            },
            monthly: null,
            weekly: null,
        },
    };
}

function localQuota(usedPercent: number): ProviderQuota {
    return {
        capturedAt: 10,
        source: "codex",
        windows: {
            fiveHour: {
                capturedAt: 10,
                resetsAt: 20,
                status: "available",
                usedPercent,
            },
            weekly: { status: "unavailable" },
        },
    };
}
