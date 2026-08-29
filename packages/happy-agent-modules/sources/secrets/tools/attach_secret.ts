import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    secretAttachReferenceResultSchema,
    secretIdSchema,
    secretScopeRefSchema,
} from "../Secret.js";
import type { SecretsModule } from "../SecretsModule.js";

const attachSecretInputSchema = Type.Object(
    {
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

type AttachSecretInput = Static<typeof attachSecretInputSchema>;

const attachSecretResultSchema = secretAttachReferenceResultSchema;

type AttachSecretResult = Static<typeof attachSecretResultSchema>;

/** Attach a reference to an opaque scope; the result remains metadata-only. */
export function attachSecretTool(secrets: SecretsModule, actingAgentId: string) {
    return {
        ...defineAgentTool({
            name: "attach_secret",
            defer: true,
            capabilities: [
                "List and attach registered secret references without revealing values.",
            ],
            searchKeywords: [
                "attach credentials",
                "enable secret scope",
                "secret reference availability",
            ],
            description:
                "Attach a registered secret reference to an opaque host scope. This changes availability only; it never returns the secret value.",
            parameters: attachSecretInputSchema,
            returnType: attachSecretResultSchema,
            durable: true,
            transactional: true,
            describeAutoPermissionAction: ({ scopeRef, secretId }) =>
                `attaching secret reference ${JSON.stringify(secretId)} to scope ${JSON.stringify(scopeRef)}. This grants that scope access to the secret for later host operations`,
            shouldReviewInAutoMode: () => true,
            execute: async (ctx, input: AttachSecretInput): Promise<AttachSecretResult> =>
                await secrets.attachWithReference(ctx, actingAgentId, input),
            toLLM: ({ attachment, secret }) => [
                {
                    type: "text" as const,
                    text: secrets.formatAttachmentForModel(attachment.scopeRef, secret),
                },
            ],
        }),
    };
}
