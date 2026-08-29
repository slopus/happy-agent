import { Type, type Static } from "@sinclair/typebox";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";

import { secretApiAttachmentSchema } from "../SecretApi.js";
import type { SecretsModule } from "../SecretsModule.js";

const detachSecretResultSchema = Type.Object(
    {
        detached: Type.Boolean(),
        attachment: Type.Union([secretApiAttachmentSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

const detachSecretInputSchema = Type.Object(
    {
        secretId: cuid2Schema,
    },
    { additionalProperties: false },
);

type DetachSecretInput = Static<typeof detachSecretInputSchema>;
type DetachSecretResult = Static<typeof detachSecretResultSchema>;

/** Detach one reference and report only its safe identity. */
export function detachSecretTool(secrets: SecretsModule, agentId: string) {
    return defineAgentTool({
        name: "detach_secret",
        defer: true,
        capabilities: ["List and attach registered secret references without revealing values."],
        searchKeywords: ["detach credentials", "disable secret scope", "remove secret reference"],
        description:
            "Detach a secret reference from this exact agent. The result contains only identifiers and never the secret value.",
        parameters: detachSecretInputSchema,
        returnType: detachSecretResultSchema,
        durable: true,
        transactional: true,
        describeAutoPermissionAction: ({ secretId }) =>
            `detaching secret reference ${JSON.stringify(secretId)} from scope ${JSON.stringify(agentId)}. This revokes that exact agent's direct access to the secret for later host operations`,
        shouldReviewInAutoMode: () => true,
        execute: async (ctx, input: DetachSecretInput): Promise<DetachSecretResult> => {
            const attachment = await secrets.detachCatalogSecret(ctx, input.secretId, {
                type: "agent",
                id: agentId,
            });
            return { detached: attachment !== undefined, attachment: attachment ?? null };
        },
        toLLM: ({ detached, attachment }) => {
            if (detached && attachment === null) {
                throw new Error("A detached secret result is missing its attachment.");
            }
            return [
                {
                    type: "text" as const,
                    text:
                        attachment === null
                            ? `That secret was not directly attached to exact agent ${JSON.stringify(agentId)}.`
                            : `Detached ${JSON.stringify(attachment.secretId)} from exact agent ${JSON.stringify(attachment.target.id)}.`,
                },
            ];
        },
    });
}
