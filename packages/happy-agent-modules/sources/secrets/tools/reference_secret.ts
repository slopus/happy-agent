import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { secretApiIdSchema, secretApiRecordSchema } from "../SecretApi.js";
import type { SecretsModule } from "../SecretsModule.js";

const referenceSecretInputSchema = Type.Object(
    { id: secretApiIdSchema },
    { additionalProperties: false },
);
const referenceSecretResultSchema = Type.Object(
    {
        secret: Type.Union([secretApiRecordSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

type ReferenceSecretInput = Static<typeof referenceSecretInputSchema>;
type ReferenceSecretResult = Static<typeof referenceSecretResultSchema>;

/** Look up one bounded safe reference without exposing its values. */
export function referenceSecretTool(secrets: SecretsModule) {
    return defineAgentTool({
        name: "reference_secret",
        defer: true,
        capabilities: ["List and attach registered secret references without revealing values."],
        searchKeywords: ["secret metadata", "credential description", "environment variables"],
        description:
            "Read one secret reference, including its description and environment-variable names. The secret value is never returned.",
        parameters: referenceSecretInputSchema,
        returnType: referenceSecretResultSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ReferenceSecretInput): Promise<ReferenceSecretResult> => ({
            secret: (await secrets.catalogSecret(ctx, input.id)) ?? null,
        }),
        toLLM: ({ secret }) => [
            {
                type: "text" as const,
                text:
                    secret === null
                        ? "That secret reference is not registered."
                        : secrets.formatCatalogPageForModel({
                              secrets: [secret],
                              nextCursor: null,
                          }),
            },
        ],
    });
}
