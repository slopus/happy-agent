import { Type, type Static } from "@sinclair/typebox";
import type { FileContentResponse, FileRevisionResponse } from "@slopus/happy-agent-client";
import { ProjectFileError } from "../files/index.js";
import type { GitResource } from "../git/index.js";

/** Leaves room for file base64, encryption and the relay's second base64 envelope. */
export const HAPPY_READ_MAX_BYTES = 512 * 1024;
export const HAPPY_RPC_MAX_JSON_BYTES = 700_000;

export const happyGitStateRequestSchema = Type.Object({}, { additionalProperties: true });
export const happyReadFileRequestSchema = Type.Object(
    { path: Type.String({ minLength: 1, maxLength: 16_384 }) },
    { additionalProperties: true },
);
export const happyReadFileAtRevisionRequestSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 16_384 }),
        revision: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
    },
    { additionalProperties: true },
);
export type HappyReadFileRequest = Static<typeof happyReadFileRequestSchema>;
export type HappyReadFileAtRevisionRequest = Static<typeof happyReadFileAtRevisionRequestSchema>;
export type HappyReadFailure = {
    success: false;
    code: Exclude<ProjectFileError["code"], "conflict"> | "unsupported";
    error: string;
};
export type HappyGitStateResponse = { success: true; git: GitResource } | HappyReadFailure;
export type HappyReadFileResponse = ({ success: true } & FileContentResponse) | HappyReadFailure;
export type HappyReadFileAtRevisionResponse =
    | ({ success: true } & FileRevisionResponse)
    | HappyReadFailure;

export function happyReadFailure(error: unknown): HappyReadFailure {
    if (error instanceof HappyReadRefused || error instanceof ProjectFileError) {
        return {
            success: false,
            code: error.code === "conflict" ? "unavailable" : error.code,
            error: error.message,
        };
    }
    return {
        success: false,
        code: "unavailable",
        error: "The workspace could not be read. Try again shortly.",
    };
}

/** A safe explanation for the phone, never a raw filesystem or Git error. */
export class HappyReadRefused extends Error {
    constructor(
        readonly code: HappyReadFailure["code"],
        message: string,
    ) {
        super(message);
        this.name = "HappyReadRefused";
    }
}
