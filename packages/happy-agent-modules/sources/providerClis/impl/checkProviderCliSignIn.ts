import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ProviderCliId, ProviderCliSignIn } from "../ProviderCli.js";
import { homeOf, type ProviderCliMachine } from "./providerCliCatalog.js";
import { runProviderCliCommand } from "./runProviderCliCommand.js";

const CHECK_TIMEOUT_MS = 10_000;
const MAX_AUTH_FILE_BYTES = 256 * 1_024;

/**
 * What a check found. An `unknown` result says why in `unchecked`, one English sentence safe to
 * show, so a sign-in that can no longer be confirmed never drops silently to "not checked".
 */
export type ProviderCliSignInCheck = Pick<ProviderCliSignIn, "status" | "account"> & {
    readonly unchecked?: string;
};
type SignInState = ProviderCliSignInCheck;

const SIGNED_OUT: SignInState = { status: "signed_out", account: null };

/** An inconclusive check, and why. */
function unknown(unchecked: string): SignInState {
    return { status: "unknown", account: null, unchecked };
}

const NAMES: Readonly<Record<ProviderCliId, string>> = {
    claude: "Claude Code",
    codex: "Codex",
    grok: "Grok",
    antigravity: "Antigravity",
};

/** The check ran but its answer could not be read. */
function unanswered(id: ProviderCliId): SignInState {
    return unknown(`${NAMES[id]} didn't say whether it's signed in.`);
}

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
    const missing = unknown(`${NAMES[id]} isn't installed, so its sign-in can't be checked.`);
    try {
        switch (id) {
            case "claude":
                return executable === null ? missing : await checkClaude(executable, machine);
            case "codex":
                return executable === null ? missing : await checkCodex(executable, machine);
            case "grok":
                return await checkGrok(machine);
            case "antigravity":
                return executable === null ? missing : await checkAntigravity(executable, machine);
        }
    } catch {
        return unanswered(id);
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
    if (!Value.Check(claudeStatusSchema, status)) return unanswered("claude");
    if (!status.loggedIn) {
        // Claude keeps its login in the macOS keychain, which only the person's desktop session
        // can read: from any other session a signed-in Claude reports itself signed out.
        return machine.platform === "darwin" && !(await inDesktopSession(machine))
            ? unknown(KEYCHAIN_UNREADABLE)
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
    if (result.code !== 0 || !/logged in/i.test(text)) return unanswered("codex");
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
    if (!Value.Check(grokAuthSchema, store)) return unanswered("grok");
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
    return unanswered("antigravity");
}

/** Why a Claude that reports itself signed out may only be out of reach, on a Mac. */
export const KEYCHAIN_UNREADABLE =
    "Claude Code keeps its sign-in in the macOS keychain, which Happy can't read because it wasn't started from your desktop session. Start Happy from your desktop, or sign in with a setup token.";

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
