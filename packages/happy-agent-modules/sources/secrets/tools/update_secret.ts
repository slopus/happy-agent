import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    secretDescriptionSchema,
    type SecretEnvironmentVariableNames,
    type SecretHostEnvironment,
} from "../Secret.js";
import {
    secretApiEnvironmentSchema,
    secretApiRecordSchema,
    type SecretApiUpdateInput,
} from "../SecretApi.js";
import type { SecretsModule } from "../SecretsModule.js";
import { readSecretDotenv, secretDotenvFileSchema } from "./secretDotenv.js";

const updateSecretInputSchema = Type.Object(
    {
        secretId: cuid2Schema,
        environment: Type.Optional(secretApiEnvironmentSchema),
        dotenvFile: Type.Optional(secretDotenvFileSchema),
        description: Type.Optional(secretDescriptionSchema),
        availableToAgents: Type.Optional(
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
        secret: Type.Union([secretApiRecordSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

type UpdateSecretInput = Static<typeof updateSecretInputSchema>;

/** Replace one global secret from reviewed inline values or a host-side dotenv source. */
export function updateSecretTool(secrets: SecretsModule) {
    return defineAgentTool({
        name: "update_secret",
        defer: true,
        capabilities: [
            "Create, update, list, and attach registered secret references without revealing values.",
        ],
        searchKeywords: ["replace secret", "rotate credentials", "update dotenv"],
        description:
            "Update a global secret from exactly one replacement source: inline environment arguments or an absolute host .env file. Removed variables do not linger. Safe metadata is returned; attachments are unchanged.",
        parameters: updateSecretInputSchema,
        returnType: updateSecretResultSchema,
        // A retry must not re-read a dotenv file whose contents may have changed.
        durable: false,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Updating a secret mutates the global secret catalog. Inline values stay in the tool transcript. A dotenv source also reads one absolute host file.",
        describeAutoPermissionAction: ({ secretId, dotenvFile }) => {
            const source =
                dotenvFile === undefined
                    ? "inline environment arguments"
                    : `dotenv file ${quoteVisibleExact(dotenvFile)}`;
            return `updating global secret ${quoteVisibleExact(secretId)} from ${source}. Access: global secret catalog write${dotenvFile === undefined ? "" : " and unrestricted host filesystem read"}`;
        },
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: ({ dotenvFile }) => dotenvFile !== undefined,
        execute: async (ctx, input: UpdateSecretInput) => {
            const environment = await secretEnvironment(input.environment, input.dotenvFile);
            return await ctx.inTx(async (txCtx) => {
                const current = await secrets.catalogSecret(txCtx, input.secretId);
                if (current === undefined) return { secret: null };
                const secret = await secrets.updateCatalogSecret(
                    txCtx,
                    input.secretId,
                    current.version,
                    {
                        ...(input.description === undefined
                            ? {}
                            : { description: input.description }),
                        environment: replacementPatch(current.environmentVariables, environment),
                        ...(input.availableToAgents === undefined
                            ? {}
                            : { availableToAgents: input.availableToAgents }),
                    },
                );
                return { secret: secret ?? null };
            });
        },
        toLLM: ({ secret }) => [
            {
                type: "text" as const,
                text:
                    secret === null
                        ? "That global secret reference is not registered."
                        : `Updated global secret.\n${secrets.formatCatalogPageForModel({ secrets: [secret], nextCursor: null })}`,
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

function replacementPatch(
    previousNames: SecretEnvironmentVariableNames,
    replacement: SecretHostEnvironment,
): NonNullable<SecretApiUpdateInput["environment"]> {
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
