import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    secretDescriptionSchema,
    secretIdSchema,
    secretReferenceSchema,
    type SecretEnvironmentVariableNames,
    type SecretHostEnvironment,
    type SecretUpdateInput,
} from "../Secret.js";
import type { SecretsModule } from "../SecretsModule.js";
import { readSecretDotenv, secretDotenvFileSchema } from "./secretDotenv.js";

const updateSecretInputSchema = Type.Object(
    {
        secretId: secretIdSchema,
        dotenvFile: secretDotenvFileSchema,
        description: Type.Optional(secretDescriptionSchema),
        availableToModel: Type.Optional(
            Type.Boolean({
                description:
                    "Whether agents may attach this reference to commands. Omit to preserve its current setting.",
            }),
        ),
    },
    { additionalProperties: false },
);

const updateSecretResultSchema = Type.Object(
    {
        secret: Type.Union([secretReferenceSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

type UpdateSecretInput = Static<typeof updateSecretInputSchema>;

/** Replace one global secret's complete environment from a reviewed host-side dotenv source. */
export function updateSecretTool(secrets: SecretsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "update_secret",
        defer: true,
        capabilities: [
            "Create, update, list, and attach registered secret references without revealing values.",
        ],
        searchKeywords: ["replace secret", "rotate credentials", "update dotenv"],
        description:
            "Update a global secret from an absolute host .env file. The file replaces its complete environment bundle so removed variables do not linger. Safe metadata is returned; attachments are unchanged.",
        parameters: updateSecretInputSchema,
        returnType: updateSecretResultSchema,
        // A retry must not re-read a dotenv file whose contents may have changed.
        durable: false,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Updating a secret reads a host dotenv file and mutates the global secret catalog. Secret values must not be placed directly in tool arguments.",
        describeAutoPermissionAction: ({ secretId, dotenvFile }) =>
            `updating global secret ${quoteVisibleExact(secretId)} from dotenv file ${quoteVisibleExact(dotenvFile)}. Access: unrestricted host filesystem read and global secret catalog write`,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        execute: async (ctx, input: UpdateSecretInput) => {
            const environment = await readSecretDotenv(input.dotenvFile);
            return await ctx.inTx(async (txCtx) => {
                const current = await secrets.reference(txCtx, actingAgentId, input.secretId);
                if (current === undefined) return { secret: null };

                const secret = await secrets.update(txCtx, actingAgentId, input.secretId, {
                    ...(input.description === undefined ? {} : { description: input.description }),
                    environment: replacementPatch(current.environmentVariables, environment),
                    ...(input.availableToModel === undefined
                        ? {}
                        : { availableToModel: input.availableToModel }),
                });
                return { secret: secret ?? null };
            });
        },
        toLLM: ({ secret }) => [
            {
                type: "text" as const,
                text:
                    secret === null
                        ? "That global secret reference is not registered."
                        : `Updated global secret reference.\n${secrets.formatForModel({ secrets: [secret], limit: 1 })}`,
            },
        ],
    });
}

function replacementPatch(
    previousNames: SecretEnvironmentVariableNames,
    replacement: SecretHostEnvironment,
): NonNullable<SecretUpdateInput["environment"]> {
    const remaining = new Map(
        Object.entries(replacement).map(([name, value]) => [name.toUpperCase(), { name, value }]),
    );
    const patch = Object.create(null) as Record<string, string | null>;

    for (const previousName of previousNames) {
        const next = remaining.get(previousName.toUpperCase());
        Object.defineProperty(patch, previousName, {
            configurable: true,
            enumerable: true,
            value: next?.value ?? null,
            writable: true,
        });
        remaining.delete(previousName.toUpperCase());
    }
    for (const { name, value } of remaining.values()) {
        Object.defineProperty(patch, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return patch;
}
