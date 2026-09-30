import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";

const authSchema = Type.Object({
    tokens: Type.Object({ id_token: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
});
const claimsSchema = Type.Object({
    email: Type.Optional(Type.String()),
    "https://api.openai.com/profile": Type.Optional(
        Type.Object({ email: Type.Optional(Type.String()) }),
    ),
});

/** Fail before inference if this opt-in test would bill a different local account. */
export async function assertLiveCodexAccount(credential: CodexSessionCredential): Promise<void> {
    const expected = process.env.RIG_LIVE_ACCOUNT_EMAIL?.trim().toLowerCase();
    if (!expected) return;
    try {
        const stored: unknown = JSON.parse(await readFile(credential.authFile, "utf8"));
        if (!Value.Check(authSchema, stored)) throw new Error();
        const emails: string[] = [];
        for (const token of [stored.tokens.id_token, credential.credential.accessToken]) {
            if (!token) continue;
            const payload = token.split(".")[1];
            if (payload === undefined) continue;
            const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
            if (!Value.Check(claimsSchema, claims)) throw new Error();
            const email = claims.email ?? claims["https://api.openai.com/profile"]?.email;
            if (email !== undefined) emails.push(email.toLowerCase());
        }
        if (emails.length === 0 || emails.some((email) => email !== expected)) throw new Error();
    } catch {
        // Never expose credential contents, token claims, or another account's identity.
        throw new Error(
            "The local Codex login could not be verified as the requested account; no inference was run.",
        );
    }
}
