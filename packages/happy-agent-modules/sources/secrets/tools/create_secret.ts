import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { secretDescriptionSchema, secretIdSchema, secretReferenceSchema } from "../Secret.js";
import type { SecretsModule } from "../SecretsModule.js";
import { readSecretDotenv, secretDotenvFileSchema } from "./secretDotenv.js";

const createSecretInputSchema = Type.Object(
    {
        id: secretIdSchema,
        description: secretDescriptionSchema,
        dotenvFile: secretDotenvFileSchema,
        availableToModel: Type.Optional(
            Type.Boolean({
                description:
                    "Whether agents may attach this reference to commands. Defaults to available.",
            }),
        ),
    },
    { additionalProperties: false },
);

const createSecretResultSchema = Type.Object(
    { secret: secretReferenceSchema },
    { additionalProperties: false },
);

type CreateSecretInput = Static<typeof createSecretInputSchema>;

/** Create or replace one global secret from a reviewed host-side dotenv source. */
export function createSecretTool(secrets: SecretsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "create_secret",
        defer: true,
        capabilities: [
            "Create, update, list, and attach registered secret references without revealing values.",
        ],
        searchKeywords: ["add secret", "import dotenv", "store environment credentials"],
        description:
            "Create or replace one global secret from an absolute host .env file. This stores the file's complete environment bundle, returns safe metadata only, and does not attach the secret to any agent.",
        parameters: createSecretInputSchema,
        returnType: createSecretResultSchema,
        // A retry must not re-read a dotenv file whose contents may have changed.
        durable: false,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Creating a secret reads a host dotenv file and mutates the global secret catalog. Secret values must not be placed directly in tool arguments.",
        describeAutoPermissionAction: ({ id, dotenvFile }) =>
            `creating or replacing global secret ${quoteVisibleExact(id)} from dotenv file ${quoteVisibleExact(dotenvFile)}. Access: unrestricted host filesystem read and global secret catalog write`,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        execute: async (ctx, input: CreateSecretInput) => {
            const environment = await readSecretDotenv(input.dotenvFile);
            const secret = await secrets.register(ctx, actingAgentId, {
                id: input.id,
                description: input.description,
                environment,
                ...(input.availableToModel === undefined
                    ? {}
                    : { availableToModel: input.availableToModel }),
            });
            return { secret };
        },
        toLLM: ({ secret }) => [
            {
                type: "text" as const,
                text: `Created global secret reference.\n${secrets.formatForModel({ secrets: [secret], limit: 1 })}`,
            },
        ],
    });
}
