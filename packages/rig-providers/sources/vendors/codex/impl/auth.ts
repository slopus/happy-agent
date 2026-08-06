import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/*
 * Codex writes JSON null for whichever half of the file it is not using: a
 * ChatGPT login stores `OPENAI_API_KEY: null`, and API key mode stores
 * `tokens: null`. A schema that accepts only a string rejects the whole file,
 * and a rejected file reads as "no credentials at all", so every field Codex
 * can null out is accepted here and collapsed onto the absent case below.
 */
const nullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));

const codexAuthFileSchema = Type.Object(
    {
        auth_mode: nullableString,
        OPENAI_API_KEY: nullableString,
        tokens: Type.Optional(
            Type.Union([
                Type.Object(
                    {
                        access_token: nullableString,
                        account_id: nullableString,
                        id_token: nullableString,
                    },
                    { additionalProperties: true },
                ),
                Type.Null(),
            ]),
        ),
    },
    { additionalProperties: true },
);

function present(value: string | null | undefined): string | undefined {
    return value ?? undefined;
}

type CodexAuthFile = Static<typeof codexAuthFileSchema>;

export function getCodexAuthPath(
    options: { authFile?: string; env?: NodeJS.ProcessEnv } = {},
): string {
    if (options.authFile?.trim()) return options.authFile;

    const codexHome = (options.env ?? process.env).CODEX_HOME?.trim();
    return join(codexHome || homedir(), codexHome ? "auth.json" : ".codex/auth.json");
}

export interface CodexQuotaAuth {
    accessToken: string;
    accountId?: string;
}

export type CodexStoredAuth =
    | { authMode: "apikey"; apiKey?: string }
    | { authMode: "session"; quotaAuth?: CodexQuotaAuth };

export function readCodexAuth(contents: string): CodexStoredAuth | undefined {
    const parsed: unknown = JSON.parse(contents);
    if (!Value.Check(codexAuthFileSchema, parsed)) {
        return undefined;
    }
    if (parsed.auth_mode === "apikey") {
        const apiKey = present(parsed.OPENAI_API_KEY);
        return {
            authMode: "apikey",
            ...(apiKey === undefined ? {} : { apiKey }),
        };
    }

    const quotaAuth = readQuotaAuth(parsed);
    return {
        authMode: "session",
        ...(quotaAuth === undefined ? {} : { quotaAuth }),
    };
}

export async function readCodexAuthFile(path: string): Promise<CodexStoredAuth | undefined> {
    try {
        return readCodexAuth(await readFile(path, "utf8"));
    } catch (error) {
        if (isFileNotFound(error)) {
            return undefined;
        }
        throw error;
    }
}

export function readCodexQuotaAuth(contents: string): CodexQuotaAuth | undefined {
    const auth = readCodexAuth(contents);
    return auth?.authMode === "session" ? auth.quotaAuth : undefined;
}

function readQuotaAuth(parsed: CodexAuthFile): CodexQuotaAuth | undefined {
    const accessToken = present(parsed.tokens?.access_token);
    if (accessToken === undefined || accessToken.length === 0) {
        return undefined;
    }

    const storedAccountId = present(parsed.tokens?.account_id);
    if (storedAccountId !== undefined && storedAccountId.length > 0) {
        return { accessToken, accountId: storedAccountId };
    }

    for (const token of [present(parsed.tokens?.id_token), accessToken]) {
        if (token === undefined) {
            continue;
        }
        try {
            const payload = token.split(".")[1];
            if (payload === undefined) {
                continue;
            }
            const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
                "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
            };
            const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
            if (typeof accountId === "string" && accountId.length > 0) {
                return { accessToken, accountId };
            }
        } catch {
            // A bearer token need not be a JWT, so an undecodable token is still usable.
        }
    }

    return { accessToken };
}

export async function readCodexQuotaAuthFile(path: string): Promise<CodexQuotaAuth | undefined> {
    const auth = await readCodexAuthFile(path);
    return auth?.authMode === "session" ? auth.quotaAuth : undefined;
}

function isFileNotFound(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
