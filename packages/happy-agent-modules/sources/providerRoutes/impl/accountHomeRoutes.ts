import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ProviderRoute } from "../ProviderRoute.js";
import type { DetectedRoute } from "./DetectedRoute.js";
import { homeOf, providerIdFrom, type RouteMachine } from "./RouteMachine.js";

const MAX_HOMES = 20;
const MAX_CLAUDE_STATE_BYTES = 8 * 1_024 * 1_024;
const MAX_AUTH_FILE_BYTES = 256 * 1_024;

const claudeStateSchema = Type.Object({
    oauthAccount: Type.Optional(
        Type.Object({ emailAddress: Type.Optional(Type.String({ maxLength: 320 })) }),
    ),
});
const codexAuthSchema = Type.Object({
    OPENAI_API_KEY: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    tokens: Type.Optional(
        Type.Union([
            Type.Object({ id_token: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
            Type.Null(),
        ]),
    ),
});
const codexClaimsSchema = Type.Object({
    email: Type.Optional(Type.String({ maxLength: 320 })),
    "https://api.openai.com/auth": Type.Optional(
        Type.Object({ chatgpt_plan_type: Type.Optional(Type.String({ maxLength: 64 })) }),
    ),
});

/**
 * Another Claude Code or Codex account kept in its own home folder beside the default one, such as
 * `~/.claude-work` with `CLAUDE_CONFIG_DIR` or `~/.codex-personal` with `CODEX_HOME`. Only folder
 * names in the home directory and the sign-in files inside them are read; the macOS keychain never
 * is, so a Claude home whose login lives there is `unknown`.
 *
 * `existing(type, folder)` names a configured provider already using that folder.
 */
export async function accountHomeRoutes(
    machine: RouteMachine,
    models: (type: "claude" | "codex") => ProviderRoute["models"],
    existing: (type: "claude" | "codex", folder: string) => string | undefined,
): Promise<DetectedRoute[]> {
    const home = homeOf(machine);
    const names = await homeFolderNames(home);
    const claudeActive = activeFolder(machine.env["CLAUDE_CONFIG_DIR"], join(home, ".claude"));
    const codexActive = activeFolder(machine.env["CODEX_HOME"], join(home, ".codex"));
    const routes = await Promise.all([
        ...names
            .filter((name) => /^\.claude[-_.][\w.-]+$/u.test(name))
            .map((name) => join(home, name))
            .filter((folder) => folder !== claudeActive)
            .slice(0, MAX_HOMES)
            .map(async (folder) => await claudeHome(folder, models, existing)),
        ...names
            .filter((name) => /^\.codex[-_.][\w.-]+$/u.test(name))
            .map((name) => join(home, name))
            .filter((folder) => folder !== codexActive)
            .slice(0, MAX_HOMES)
            .map(async (folder) => await codexHome(folder, models, existing)),
    ]);
    return routes.filter((route) => route !== undefined);
}

async function claudeHome(
    folder: string,
    models: (type: "claude") => ProviderRoute["models"],
    existing: (type: "claude", folder: string) => string | undefined,
): Promise<DetectedRoute | undefined> {
    const name = basename(folder);
    const state = parseJson(await readSmall(join(folder, ".claude.json"), MAX_CLAUDE_STATE_BYTES));
    const email = Value.Check(claudeStateSchema, state)
        ? (state.oauthAccount?.emailAddress ?? null)
        : null;
    const signedIn = Value.Check(claudeStateSchema, state) && state.oauthAccount !== undefined;
    // Linux and Windows keep the login in this file; macOS keeps it in the keychain.
    const credentials = await isNonEmptyFile(join(folder, ".credentials.json"));
    if (!signedIn && !credentials) return undefined;
    return {
        id: `claude_home:${name}`,
        kind: "direct",
        name: `Claude Code (~/${name})`,
        vendors: ["Anthropic"],
        billing: "subscription",
        account: { label: email ?? name, email, plan: null, count: null },
        endpoint: null,
        status: credentials ? "ready" : "unknown",
        models: models("claude"),
        warning: null,
        provider: {
            id:
                existing("claude", folder) ??
                providerIdFrom("claude", name.slice(".claude".length)),
            table: { type: "claude", name: `Claude (~/${name})`, config_dir: folder },
            summary: `Adds Claude Code with the account in ~/${name}.`,
        },
    };
}

async function codexHome(
    folder: string,
    models: (type: "codex") => ProviderRoute["models"],
    existing: (type: "codex", folder: string) => string | undefined,
): Promise<DetectedRoute | undefined> {
    const name = basename(folder);
    const authFile = join(folder, "auth.json");
    const auth = parseJson(await readSmall(authFile, MAX_AUTH_FILE_BYTES));
    if (!Value.Check(codexAuthSchema, auth)) return undefined;
    const idToken = auth.tokens?.id_token;
    const hasKey = typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0;
    if (typeof idToken !== "string" && !hasKey) return undefined;
    const claims = typeof idToken === "string" ? jwtClaims(idToken) : undefined;
    const email = Value.Check(codexClaimsSchema, claims) ? (claims.email ?? null) : null;
    const plan = Value.Check(codexClaimsSchema, claims)
        ? displayPlan(claims["https://api.openai.com/auth"]?.chatgpt_plan_type)
        : null;
    return {
        id: `codex_home:${name}`,
        kind: "direct",
        name: `Codex (~/${name})`,
        vendors: ["OpenAI"],
        billing: typeof idToken === "string" ? "subscription" : "pay_per_token",
        account: { label: email ?? name, email, plan, count: null },
        endpoint: null,
        status: "ready",
        models: models("codex"),
        warning: null,
        provider: {
            id: existing("codex", folder) ?? providerIdFrom("codex", name.slice(".codex".length)),
            table: { type: "codex", name: `Codex (~/${name})`, auth_file: authFile },
            summary: `Adds Codex with the account in ~/${name}.`,
        },
    };
}

/** The folder names directly in the home directory; nothing inside them is listed. */
async function homeFolderNames(home: string): Promise<string[]> {
    try {
        const entries = await readdir(home, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
}

function activeFolder(configured: string | undefined, fallback: string): string {
    const trimmed = configured?.trim();
    return trimmed ? resolve(trimmed) : fallback;
}

/** Vendors report plans as identifiers such as `plus`; people read `Plus`. */
function displayPlan(plan: string | undefined): string | null {
    const trimmed = plan?.trim();
    if (trimmed === undefined || trimmed.length === 0) return null;
    return trimmed
        .split(/[_\s-]+/u)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function jwtClaims(token: string): unknown {
    const payload = token.split(".")[1];
    if (payload === undefined) return undefined;
    return parseJson(Buffer.from(payload, "base64url").toString("utf8"));
}

function parseJson(source: string | undefined): unknown {
    if (source === undefined) return undefined;
    try {
        return JSON.parse(source);
    } catch {
        return undefined;
    }
}

async function readSmall(path: string, limit: number): Promise<string | undefined> {
    try {
        if ((await stat(path)).size > limit) return undefined;
        return await readFile(path, "utf8");
    } catch {
        return undefined;
    }
}

async function isNonEmptyFile(path: string): Promise<boolean> {
    try {
        const facts = await stat(path);
        return facts.isFile() && facts.size > 0;
    } catch {
        return false;
    }
}
