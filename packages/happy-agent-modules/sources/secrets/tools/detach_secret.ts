import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { secretIdSchema, secretScopeRefSchema } from "../Secret.js";
import type { SecretsModule } from "../SecretsModule.js";

const detachSecretResultSchema = Type.Object(
    {
        detached: Type.Boolean(),
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

const detachSecretInputSchema = Type.Object(
    {
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

type DetachSecretInput = Static<typeof detachSecretInputSchema>;
type DetachSecretResult = Static<typeof detachSecretResultSchema>;

/** Detach one reference and report only its safe identity. */
export function detachSecretTool(secrets: SecretsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "detach_secret",
        defer: true,
        capabilities: ["List and attach registered secret references without revealing values."],
        searchKeywords: ["detach credentials", "disable secret scope", "remove secret reference"],
        description:
            "Detach a secret reference from an opaque host scope. The result contains only identifiers and never the secret value.",
        parameters: detachSecretInputSchema,
        returnType: detachSecretResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: DetachSecretInput): Promise<DetachSecretResult> => ({
            detached: await secrets.detach(ctx, actingAgentId, input),
            scopeRef: input.scopeRef,
            secretId: input.secretId,
        }),
        toLLM: ({ detached, scopeRef, secretId }) => [
            {
                type: "text" as const,
                text: secrets.formatDetachForModel(detached, scopeRef, secretId),
            },
        ],
    });
}
