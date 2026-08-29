import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    secretApiAttachmentSchema,
    secretApiIdSchema,
    secretApiRecordSchema,
} from "../SecretApi.js";
import type { SecretsModule } from "../SecretsModule.js";

const attachSecretInputSchema = Type.Object(
    {
        secretId: secretApiIdSchema,
    },
    { additionalProperties: false },
);

type AttachSecretInput = Static<typeof attachSecretInputSchema>;

const attachSecretResultSchema = Type.Object(
    { attachment: secretApiAttachmentSchema, secret: secretApiRecordSchema },
    { additionalProperties: false },
);

type AttachSecretResult = Static<typeof attachSecretResultSchema>;

/** Attach one global catalog secret to the exact current agent. */
export function attachSecretTool(secrets: SecretsModule, agentId: string) {
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
                "Attach a registered secret reference to this exact agent. This changes availability only; it never returns the secret value.",
            parameters: attachSecretInputSchema,
            returnType: attachSecretResultSchema,
            durable: true,
            transactional: true,
            describeAutoPermissionAction: ({ secretId }) =>
                `attaching secret reference ${JSON.stringify(secretId)} to scope ${JSON.stringify(agentId)}. This grants that exact agent access to the secret for later host operations`,
            shouldReviewInAutoMode: () => true,
            execute: async (ctx, input: AttachSecretInput): Promise<AttachSecretResult> => {
                const secret = await secrets.catalogSecret(ctx, input.secretId);
                if (secret === undefined) throw new Error("That global secret is not registered.");
                const { attachment } = await secrets.attachCatalogSecret(ctx, input.secretId, {
                    type: "agent",
                    id: agentId,
                });
                return { attachment, secret };
            },
            toLLM: ({ attachment, secret }) => [
                {
                    type: "text" as const,
                    text: `Attached ${JSON.stringify(secret.id)} to exact agent ${JSON.stringify(attachment.target.id)}.\n${secrets.formatCatalogPageForModel({ secrets: [secret], nextCursor: null })}`,
                },
            ],
        }),
    };
}
