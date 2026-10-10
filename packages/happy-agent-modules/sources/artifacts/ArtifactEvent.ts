import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    artifactRecordSchema,
    artifactTimestampSchema,
    artifactVersionSchema,
} from "./Artifact.js";

const envelope = {
    eventId: Type.String({ minLength: 1, maxLength: 128 }),
    at: artifactTimestampSchema,
} as const;

export const artifactEventSchema = Type.Union([
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("artifact_created"),
            artifact: artifactRecordSchema,
            version: artifactVersionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("artifact_updated"),
            artifact: artifactRecordSchema,
            previousArtifact: artifactRecordSchema,
            version: artifactVersionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("artifact_deleted"),
            artifact: artifactRecordSchema,
            previousArtifact: artifactRecordSchema,
        },
        { additionalProperties: false },
    ),
]);

export type ArtifactEvent = Static<typeof artifactEventSchema>;
export type ArtifactEventListener = (ctx: Context, event: ArtifactEvent) => Promise<void> | void;
export type ArtifactUnsubscribe = () => void;
