import { createHash } from "node:crypto";

import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import {
    ArtifactDataConflictError,
    ArtifactDataInputError,
    artifactDataEntrySchema,
    artifactDataKeySchema,
    artifactDataVersionSchema,
    type ArtifactDataCondition,
} from "../ArtifactData.js";
import type { ArtifactDataModule } from "../ArtifactDataModule.js";
import { ARTIFACT_DATA_TOOL_CAPABILITY } from "./common.js";

const writeArtifactDataToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        key: Type.String({ ...artifactDataKeySchema, description: 'The key, such as "todos/7"' }),
        value: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 1024 * 1024,
                description:
                    'The new value as JSON text, such as {"title":"Milk","done":false}, "text", 3, or null',
            }),
        ),
        delete: Type.Optional(
            Type.Boolean({ description: "true deletes the key instead of setting it" }),
        ),
        ifVersion: Type.Optional(
            Type.String({
                ...artifactDataVersionSchema,
                description:
                    "Write only while the key is still at this version, as read_artifact_data showed it",
            }),
        ),
        ifAbsent: Type.Optional(
            Type.Boolean({ description: "true writes only while the key holds no value" }),
        ),
    },
    { additionalProperties: false },
);
type WriteArtifactDataToolInput = Static<typeof writeArtifactDataToolInputSchema>;

/** Set or delete one key of an HTML artifact's live data, as this agent. */
export function writeArtifactDataTool(data: ArtifactDataModule, agentId: string) {
    return defineAgentTool({
        name: "write_artifact_data",
        defer: true,
        capabilities: [ARTIFACT_DATA_TOOL_CAPABILITY],
        searchKeywords: [
            "artifact data",
            "write artifact store",
            "seed artifact app",
            "update artifact app data",
        ],
        description: [
            "Set or delete one key in the live data of an HTML artifact app: the key-value store its pages share through /api/v1/client.js. Every open copy of the page sees the change at once, and the write is recorded as made by you.",
            'Pass value as JSON text to set the key, or delete: true to delete it. Follow the keys and value shapes the page\'s own script uses, such as one key per item under a prefix ("todos/<id>"); read its index.html with read_artifact_file when unsure. Pass ifVersion, from read_artifact_data, so you never overwrite a change you did not see, or ifAbsent: true to only create. Values hold at most 256 KiB of JSON.',
        ].join("\n\n"),
        parameters: writeArtifactDataToolInputSchema,
        returnType: artifactDataEntrySchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        // The call's own ID is the write ID, so a call repeated after an interruption is answered
        // with the write it already made instead of applying again.
        execute: async (ctx, input: WriteArtifactDataToolInput, call) => {
            if ((input.value === undefined) === (input.delete !== true)) {
                throw new ArtifactDataInputError("Pass either value or delete: true.");
            }
            if (input.ifVersion !== undefined && input.ifAbsent === true) {
                throw new ArtifactDataInputError("Pass ifVersion or ifAbsent, not both.");
            }
            const condition: ArtifactDataCondition | undefined =
                input.ifVersion !== undefined
                    ? { ifVersion: input.ifVersion }
                    : input.ifAbsent === true
                      ? { ifAbsent: true }
                      : undefined;
            const write = {
                key: input.key,
                author: { kind: "agent" as const, agentId },
                writeId: `call-${createHash("sha256").update(call.id).digest("hex").slice(0, 40)}`,
                ...(condition === undefined ? {} : { condition }),
            };
            try {
                if (input.delete === true) {
                    return (await data.delete(ctx, input.artifactId, write)).entry;
                }
                let value: unknown;
                try {
                    value = JSON.parse(input.value ?? "");
                } catch {
                    throw new ArtifactDataInputError("value must be valid JSON text.");
                }
                return (await data.set(ctx, input.artifactId, { ...write, value })).entry;
            } catch (error: unknown) {
                if (!(error instanceof ArtifactDataConflictError)) throw error;
                throw new ArtifactDataConflictError(
                    error.entry,
                    error.entry === null
                        ? `The key ${JSON.stringify(input.key)} holds no value now, so nothing was written.`
                        : `The key ${JSON.stringify(input.key)} is now at version ${error.entry.version} with ${JSON.stringify(error.entry.value)}, so nothing was written. Read it again and decide.`,
                );
            }
        },
        toLLM: (entry) => [
            {
                type: "text",
                text: entry.deleted
                    ? `Deleted ${JSON.stringify(entry.key)}; version ${entry.version}.`
                    : `Set ${JSON.stringify(entry.key)}; version ${entry.version}. Every open copy of the page now sees it.`,
            },
        ],
    });
}
