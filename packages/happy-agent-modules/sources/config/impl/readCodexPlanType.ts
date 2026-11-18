import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAX_AUTH_FILE_BYTES = 256 * 1_024;

const authSchema = Type.Object({
    tokens: Type.Object({ id_token: Type.String({ maxLength: MAX_AUTH_FILE_BYTES }) }),
});
const claimsSchema = Type.Object({
    "https://api.openai.com/auth": Type.Object({
        chatgpt_plan_type: Type.String({ minLength: 1, maxLength: 64 }),
    }),
});

/** The ChatGPT plan a stored Codex login's ID token names, or undefined when it cannot be read. */
export async function readCodexPlanType(authFile: string): Promise<string | undefined> {
    try {
        const text = await readFile(authFile, "utf8");
        if (text.length > MAX_AUTH_FILE_BYTES) return undefined;
        const auth: unknown = JSON.parse(text);
        if (!Value.Check(authSchema, auth)) return undefined;
        const payload = auth.tokens.id_token.split(".")[1];
        if (payload === undefined) return undefined;
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Value.Check(claimsSchema, claims)
            ? claims["https://api.openai.com/auth"].chatgpt_plan_type.trim().toLowerCase()
            : undefined;
    } catch {
        // An unreadable login names no plan; credential contents never reach diagnostics.
        return undefined;
    }
}
