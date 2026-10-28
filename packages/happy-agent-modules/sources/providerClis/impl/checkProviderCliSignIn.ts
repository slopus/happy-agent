import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ProviderCliId, ProviderCliSignIn } from "../ProviderCli.js";
import { homeOf, type ProviderCliMachine } from "./providerCliCatalog.js";
import { runProviderCliCommand } from "./runProviderCliCommand.js";

const CHECK_TIMEOUT_MS = 10_000;
const MAX_AUTH_FILE_BYTES = 256 * 1_024;

type SignInState = Pick<ProviderCliSignIn, "status" | "account">;

const UNKNOWN: SignInState = { status: "unknown", account: null };
const SIGNED_OUT: SignInState = { status: "signed_out", account: null };

const claudeStatusSchema = Type.Object({
    loggedIn: Type.Boolean(),
    email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    subscriptionType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const codexAuthSchema = Type.Object({
    tokens: Type.Optional(
        Type.Union([
            Type.Object({ id_token: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
            Type.Null(),
        ]),
    ),
});
const codexClaimsSchema = Type.Object({
    email: Type.Optional(Type.String()),
    "https://api.openai.com/auth": Type.Optional(
        Type.Object({ chatgpt_plan_type: Type.Optional(Type.String()) }),
    ),
});
const GROK_OAUTH_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const grokAuthSchema = Type.Record(
    Type.String(),
    Type.Object({
        key: Type.Optional(Type.String()),
        email: Type.Optional(Type.String()),
    }),
);

/**
 * Ask the installed program, or the sign-in it keeps on disk, whether it is signed in. Only
 * the account's email and plan leave this function; tokens are read only to find those claims.
 */
export async function checkProviderCliSignIn(
    id: ProviderCliId,
    executable: string | null,
    machine: ProviderCliMachine,
): Promise<SignInState> {
    try {
        switch (id) {
            case "claude":
                return executable === null ? UNKNOWN : await checkClaude(executable, machine);
            case "codex":
                return executable === null ? UNKNOWN : await checkCodex(executable, machine);
            case "grok":
                return await checkGrok(machine);
            case "antigravity":
                return executable === null ? UNKNOWN : await checkAntigravity(executable, machine);
        }
    } catch {
        return UNKNOWN;
    }
}

async function checkClaude(executable: string, machine: ProviderCliMachine): Promise<SignInState> {
    const result = await runProviderCliCommand(
        executable,
        ["auth", "status", "--json"],
        machine.env,
        CHECK_TIMEOUT_MS,
    );
    const status = parseJson(result.stdout);
    if (!Value.Check(claudeStatusSchema, status)) return UNKNOWN;
    if (!status.loggedIn) {
        // Claude keeps its login in the macOS keychain, which only the person's desktop session
        // can read: from any other session a signed-in Claude reports itself signed out.
        return machine.platform === "darwin" && !(await inDesktopSession(machine))
            ? UNKNOWN
            : SIGNED_OUT;
    }
    return {
        status: "signed_in",
        account: { email: status.email ?? null, plan: displayPlan(status.subscriptionType) },
    };
}

async function checkCodex(executable: string, machine: ProviderCliMachine): Promise<SignInState> {
    const result = await runProviderCliCommand(
        executable,
        ["login", "status"],
        machine.env,
        CHECK_TIMEOUT_MS,
    );
    const text = `${result.stdout}\n${result.stderr}`;
    if (/not logged in/i.test(text)) return SIGNED_OUT;
    if (result.code !== 0 || !/logged in/i.test(text)) return UNKNOWN;
    const codexHome = machine.env["CODEX_HOME"]?.trim() || join(homeOf(machine), ".codex");
    const auth = parseJson(await readSmallFile(join(codexHome, "auth.json")));
    const idToken = Value.Check(codexAuthSchema, auth) ? auth.tokens?.id_token : undefined;
    const claims = typeof idToken === "string" ? jwtClaims(idToken) : undefined;
    if (!Value.Check(codexClaimsSchema, claims)) {
        return { status: "signed_in", account: { email: null, plan: null } };
    }
    return {
        status: "signed_in",
        account: {
            email: claims.email ?? null,
            plan: displayPlan(claims["https://api.openai.com/auth"]?.chatgpt_plan_type),
        },
    };
}

/** Grok keeps its sign-in in `~/.grok/auth.json`; reading it needs neither the program nor the network. */
async function checkGrok(machine: ProviderCliMachine): Promise<SignInState> {
    const grokHome = machine.env["GROK_HOME"]?.trim();
    const path = grokHome
        ? join(grokHome, "auth.json")
        : join(homeOf(machine), ".grok", "auth.json");
    const source = await readSmallFile(path);
    if (source === undefined) return SIGNED_OUT;
    const store = parseJson(source);
    if (!Value.Check(grokAuthSchema, store)) return UNKNOWN;
    const session = store[GROK_OAUTH_SCOPE];
    if (session?.key === undefined || session.key.trim().length === 0) return SIGNED_OUT;
    return { status: "signed_in", account: { email: session.email ?? null, plan: null } };
}

/**
 * agy keeps its sign-in in the OS keyring, or in a file when there is none. The file answers
 * without running anything; otherwise `agy models` refuses at once when signed out.
 */
async function checkAntigravity(
    executable: string,
    machine: ProviderCliMachine,
): Promise<SignInState> {
    const tokenFile = join(
        homeOf(machine),
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token",
    );
    if (await isNonEmptyFile(tokenFile)) {
        return { status: "signed_in", account: { email: null, plan: null } };
    }
    const result = await runProviderCliCommand(
        executable,
        ["models"],
        machine.env,
        CHECK_TIMEOUT_MS,
    );
    const text = `${result.stdout}\n${result.stderr}`;
    if (/please sign in|not logged in/i.test(text)) return SIGNED_OUT;
    if (result.code === 0) return { status: "signed_in", account: { email: null, plan: null } };
    return UNKNOWN;
}

let desktopSession: Promise<boolean> | undefined;

/** Whether this process runs in the person's macOS desktop (Aqua) session, asked once. */
async function inDesktopSession(machine: ProviderCliMachine): Promise<boolean> {
    desktopSession ??= runProviderCliCommand(
        "/bin/launchctl",
        ["managername"],
        machine.env,
        CHECK_TIMEOUT_MS,
    ).then((result) => result.stdout.trim() === "Aqua");
    return await desktopSession;
}

/** Vendors report plans as identifiers such as `max` or `plus`; people read `Max` and `Plus`. */
function displayPlan(plan: string | null | undefined): string | null {
    const trimmed = plan?.trim();
    if (trimmed === undefined || trimmed.length === 0) return null;
    return trimmed
        .split(/[_\s-]+/)
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

async function readSmallFile(path: string): Promise<string | undefined> {
    try {
        if ((await stat(path)).size > MAX_AUTH_FILE_BYTES) return undefined;
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
