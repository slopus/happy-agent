import { Type, type Static } from "@sinclair/typebox";
import {
    artifactSecretActionRequestSchema,
    type ArtifactSecretActionRequest,
} from "@slopus/happy-agent-client";

import { secretApiRecordSchema } from "../secrets/index.js";

/** The body of `POST /v0/artifacts/:artifactId/versions/:number/actions`, as the client sends it. */
export const secretActionSaveRequestSchema = artifactSecretActionRequestSchema;
export type SecretActionSaveRequest = ArtifactSecretActionRequest;

export const secretActionOutcomeSchema = Type.Union([
    Type.Literal("created"),
    Type.Literal("updated"),
]);

export const secretActionSaveResultSchema = Type.Object(
    { secret: secretApiRecordSchema, outcome: secretActionOutcomeSchema },
    { additionalProperties: false },
);
export type SecretActionSaveResult = Static<typeof secretActionSaveResultSchema>;

/** Why a save was refused, in the terms the route answers with. */
export class SecretActionError extends Error {
    readonly kind: "invalid" | "not_found" | "conflict";

    constructor(kind: "invalid" | "not_found" | "conflict", message: string) {
        super(message);
        this.name = "SecretActionError";
        this.kind = kind;
    }
}
