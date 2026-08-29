import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { secretApiIdSchema, secretApiPageSchema } from "../SecretApi.js";
import type { SecretsModule } from "../SecretsModule.js";

const listSecretsInputSchema = Type.Object(
    {
        cursor: Type.Optional(secretApiIdSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
);

type ListSecretsInput = Static<typeof listSecretsInputSchema>;

/** List bounded safe metadata; this tool never asks the module to resolve values. */
export function listSecretsTool(secrets: SecretsModule) {
    return defineAgentTool({
        name: "list_secrets",
        defer: true,
        capabilities: ["List and attach registered secret references without revealing values."],
        searchKeywords: ["secret catalog", "credential references", "environment variable names"],
        description:
            "List bounded secret references and environment-variable names. Secret values are never available to the model.",
        parameters: listSecretsInputSchema,
        returnType: secretApiPageSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: ListSecretsInput) => await secrets.listCatalog(ctx, query),
        toLLM: (page) => [
            {
                type: "text" as const,
                text: secrets.formatCatalogPageForModel(page),
            },
        ],
    });
}
