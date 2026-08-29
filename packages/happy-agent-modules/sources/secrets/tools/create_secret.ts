import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { secretDescriptionSchema } from "../Secret.js";
import {
    secretApiEnvironmentSchema,
    secretApiIdSchema,
    secretApiRecordSchema,
} from "../SecretApi.js";
import type { SecretsModule } from "../SecretsModule.js";
import { readSecretDotenv, secretDotenvFileSchema } from "./secretDotenv.js";

const createSecretInputSchema = Type.Object(
    {
        id: Type.Optional(secretApiIdSchema),
        description: secretDescriptionSchema,
        environment: Type.Optional(secretApiEnvironmentSchema),
        dotenvFile: Type.Optional(secretDotenvFileSchema),
        availableToAgents: Type.Optional(
            Type.Boolean({
                description:
                    "Whether agents may attach this reference to commands. Defaults to available.",
            }),
        ),
    },
    { additionalProperties: false },
);

const createSecretResultSchema = Type.Object(
    { secret: secretApiRecordSchema },
    { additionalProperties: false },
);

type CreateSecretInput = Static<typeof createSecretInputSchema>;

/** Create one global secret from reviewed inline values or a host-side dotenv source. */
export function createSecretTool(secrets: SecretsModule) {
    return defineAgentTool({
        name: "create_secret",
        defer: true,
        capabilities: [
            "Create, update, list, and attach registered secret references without revealing values.",
        ],
        searchKeywords: ["add secret", "import dotenv", "store environment credentials"],
        description:
            "Create one global secret from exactly one value source: inline environment arguments or an absolute host .env file. Returns safe metadata only and does not attach the secret to any agent.",
        parameters: createSecretInputSchema,
        returnType: createSecretResultSchema,
        // A retry must not re-read a dotenv file whose contents may have changed.
        durable: false,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Creating a secret mutates the global secret catalog. Inline values stay in the tool transcript. A dotenv source also reads one absolute host file.",
        describeAutoPermissionAction: ({ id, dotenvFile }) => {
            const source =
                dotenvFile === undefined
                    ? "inline environment arguments"
                    : `dotenv file ${quoteVisibleExact(dotenvFile)}`;
            return `creating global secret ${id === undefined ? "with a new ID" : quoteVisibleExact(id)} from ${source}. Access: global secret catalog write${dotenvFile === undefined ? "" : " and unrestricted host filesystem read"}`;
        },
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: ({ dotenvFile }) => dotenvFile !== undefined,
        execute: async (ctx, input: CreateSecretInput) => {
            const environment = await secretEnvironment(input.environment, input.dotenvFile);
            const secret = await secrets.createCatalogSecret(ctx, {
                ...(input.id === undefined ? {} : { id: input.id }),
                description: input.description,
                environment,
                ...(input.availableToAgents === undefined
                    ? {}
                    : { availableToAgents: input.availableToAgents }),
            });
            return { secret };
        },
        toLLM: ({ secret }) => [
            {
                type: "text" as const,
                text: `Created global secret.\n${secrets.formatCatalogPageForModel({ secrets: [secret], nextCursor: null })}`,
            },
        ],
    });
}

async function secretEnvironment(
    inline: Record<string, string> | undefined,
    dotenvFile: string | undefined,
): Promise<Record<string, string>> {
    if (inline !== undefined) {
        if (dotenvFile !== undefined) {
            throw new Error("Supply exactly one secret value source: environment or dotenvFile.");
        }
        return structuredClone(inline);
    }
    if (dotenvFile === undefined) {
        throw new Error("Supply exactly one secret value source: environment or dotenvFile.");
    }
    return await readSecretDotenv(dotenvFile);
}
