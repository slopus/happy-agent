import { describe, expect, it } from "vitest";
import type { Model } from "@slopus/happy-agent-base";

import type { ConfigProviders } from "../config/types.js";
import type { ModelCatalog } from "../protocol/index.js";
import {
    buildOwnerProviderScope,
    type CredentialVisibility,
    type ProviderCredentialSource,
} from "./buildOwnerProviderScope.js";

const localId = "alocalinstance00000000001";
const ownerId = "aremoteinstance0000000001";
const otherId = "aotherinstance00000000001";

describe("buildOwnerProviderScope", () => {
    it("keeps the synchronized owner's provider IDs exact and marks local providers as extras", () => {
        const scope = buildOwnerProviderScope({
            localInstanceId: localId,
            ownerInstanceId: ownerId,
            sources: [
                source(localId, "Build Rig", ["local-bedrock"], {
                    "local-bedrock": "shared",
                }),
                source(ownerId, "Steve's Rig", ["codex", "claude"]),
            ],
        });

        expect(scope.catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            "claude",
            `local-bedrock@${localId}`,
        ]);
        expect(scope.catalog.providers.map((provider) => provider.credential.relation)).toEqual([
            "owner",
            "owner",
            "extra",
        ]);
        expect(scope.catalog.defaultProviderId).toBe("codex");
        expect(scope.catalog.providers[2]?.title).toBe("local-bedrock — provided by Build Rig");
    });

    it("namespaces every extra without changing its displayed source provider ID", () => {
        const scope = buildOwnerProviderScope({
            localInstanceId: localId,
            ownerInstanceId: ownerId,
            sources: [
                source(ownerId, "Steve's Rig", ["codex"]),
                source(localId, "Build Rig", ["codex"], { codex: "shared" }),
            ],
        });

        expect(scope.catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            `codex@${localId}`,
        ]);
        expect(scope.catalog.providers[1]?.credential).toMatchObject({
            ownerInstanceId: localId,
            relation: "extra",
            sourceProviderId: "codex",
        });
    });

    it("uses the receiving Rig's arbitrary catalog when the owner supplied nothing", () => {
        const local = source(localId, "Build Rig", ["bedrock", "grok"]);
        const scope = buildOwnerProviderScope({
            localInstanceId: localId,
            ownerInstanceId: ownerId,
            sources: [local],
        });

        expect(scope.catalog.providers.map((provider) => provider.providerId)).toEqual([
            "bedrock",
            "grok",
        ]);
        expect(
            scope.catalog.providers.every((provider) => provider.credential.relation === "owner"),
        ).toBe(true);
    });

    it("includes another peer's shared provider and excludes its owner-only provider", () => {
        const scope = buildOwnerProviderScope({
            localInstanceId: localId,
            ownerInstanceId: ownerId,
            sources: [
                source(ownerId, "Steve's Rig", ["codex"]),
                source(otherId, "Team Rig", ["shared-claude", "private-grok"], {
                    "private-grok": "owner_only",
                    "shared-claude": "shared",
                }),
            ],
        });

        expect(scope.catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            `shared-claude@${otherId}`,
        ]);
        expect(scope.providers["private-grok"]).toBeUndefined();
    });
});

function source(
    instanceId: string,
    name: string,
    providerIds: readonly string[],
    visibility: Readonly<Record<string, CredentialVisibility>> = {},
): ProviderCredentialSource {
    const providers: ConfigProviders = Object.fromEntries(
        providerIds.map((providerId) => [
            providerId,
            { enabled: true, type: providerId.includes("claude") ? "claude" : "codex" },
        ]),
    );
    const model = (providerId: string): Model => ({
        contextWindow: 100_000,
        defaultThinkingLevel: "medium",
        id: `model/${providerId}`,
        name: providerId,
        thinkingLevels: ["medium"],
    });
    const catalog: ModelCatalog = {
        defaultModelId: model(providerIds[0]!).id,
        defaultProviderId: providerIds[0]!,
        models: providerIds.map(model),
        providers: providerIds.map((providerId) => ({
            models: [model(providerId)],
            providerId,
        })),
    };
    return {
        catalog,
        instanceId,
        name,
        providers,
        visibility: Object.fromEntries(
            providerIds.map((providerId) => [providerId, visibility[providerId] ?? "owner_only"]),
        ),
    };
}
