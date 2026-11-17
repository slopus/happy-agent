import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const setupTokenSchema = Type.String({
    maxLength: 8_192,
    pattern: "^sk-ant-oat01-[A-Za-z0-9_-]+$",
});

export class ClaudeSetupTokenError extends Error {
    constructor() {
        super("Enter a valid Claude setup token.");
        this.name = "ClaudeSetupTokenError";
    }
}

/** Terminal wrapping is not part of a credential; never include rejected input in an error. */
export function normalizeClaudeSetupToken(token: string): string {
    const normalized = token.replace(/[\s\p{White_Space}]/gu, "");
    if (!Value.Check(setupTokenSchema, normalized)) throw new ClaudeSetupTokenError();
    return normalized;
}
