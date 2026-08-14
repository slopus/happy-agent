import { defineAgentTool } from "@slopus/happy-agent-base";

import { secretListInputSchema, secretPageSchema, type SecretListInput } from "../Secret.js";
import type { SecretsFeature } from "../SecretsFeature.js";

/** List bounded safe metadata; this tool never asks the feature to resolve values. */
export function listSecretsTool(secrets: SecretsFeature, actingAgentId: string) {
    return defineAgentTool({
        name: "list_secrets",
        description:
            "List bounded secret references and environment-variable names. Secret values are never available to the model.",
        parameters: secretListInputSchema,
        returnType: secretPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: SecretListInput) =>
            await secrets.list(ctx, actingAgentId, query),
        toLLM: (page) => [
            {
                type: "text" as const,
                text: secrets.formatPageForModel(page),
            },
        ],
    });
}
