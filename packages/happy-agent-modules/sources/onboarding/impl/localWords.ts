import type { ChatActionMark } from "@slopus/happy-agent-client";

import type { ProviderCli, ProviderCliId } from "../../providerClis/index.js";
import type { ProviderRoute } from "../../providerRoutes/index.js";
import type { OnboardingRuntimeOffer } from "./checkOnboardingRecipe.js";

/**
 * What the standalone daemon offers the `local` recipe, and the block variables it writes: the
 * routes table and the AI menus, in the inline action grammar.
 */
export const LOCAL_OFFER: OnboardingRuntimeOffer = {
    effects: {
        "routes.use": ["ok", "restart", "none", "failed"],
        "provider.choose": ["ok", "signIn", "install", "manual", "unusable", "failed"],
        "provider.connect": ["ok", "unusable", "failed"],
        "provider.await": ["ok", "unusable", "failed"],
        "daemon.restart": ["ok"],
    },
    conditions: new Set(["routesFound", "installed", "installable", "subjectKnown", "onPhone"]),
    variables: new Set([
        "botName",
        "machine",
        "provider",
        "providerCli",
        "providerMark",
        "cliName",
        "vendor",
        "installHost",
        "reason",
        "routesReady",
    ]),
    blocks: new Set([
        "routesTable",
        "providerMenu",
        "providerCatalog",
        "installCommand",
        "signInCommand",
        "firstProjectRecipe",
    ]),
    tools: new Set([
        "save_profile",
        "set_default_model",
        "set_bot_name",
        "find_recent_projects",
        "start_first_task",
        "send_agent_message",
        "finish_onboarding",
        "create_project",
        "clone_project",
    ]),
    requirements: new Set(["provider", "profile"]),
};

/** Each AI as the person knows it. */
export const APP_OF: Readonly<Record<ProviderCliId, string>> = {
    claude: "Claude",
    codex: "ChatGPT",
    grok: "Grok",
    antigravity: "Gemini",
};

export const MARK_OF: Readonly<Record<ProviderCliId, ChatActionMark>> = {
    claude: "claude",
    codex: "openai",
    grok: "grok",
    antigravity: "gemini",
};

const MENU_LABELS: readonly { readonly id: ProviderCliId; readonly label: string }[] = [
    { id: "claude", label: "Claude" },
    { id: "codex", label: "ChatGPT" },
    { id: "grok", label: "Grok" },
    { id: "antigravity", label: "Gemini (Antigravity)" },
];

/** The desktop model picker's own labels, so both read the same. */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
    off: "Off",
    on: "On",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Maximum",
    ultra: "Ultra",
};

/** An effort as the app shows it, "High" rather than the raw `high`. */
export function effortLabel(effort: string): string {
    return Object.hasOwn(EFFORT_LABELS, effort)
        ? EFFORT_LABELS[effort]!
        : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** "Mac" on a Mac; "computer" anywhere else. */
export function machineWord(platform: NodeJS.Platform): string {
    return platform === "darwin" ? "Mac" : "computer";
}

export function chatProviderId(id: string): ProviderCliId | undefined {
    return id === "claude" || id === "codex" || id === "grok" || id === "antigravity"
        ? id
        : undefined;
}

/** "A", "A and B", "A, B, and C". */
export function listOf(words: readonly string[]): string {
    if (words.length <= 2) return words.join(" and ");
    return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]!}`;
}

/** A sentence ends with its own stop, so a reason reads well before the next one. */
export function sentence(text: string): string {
    const trimmed = text.trim();
    if (trimmed === "") return "";
    return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Whether the person can choose a route now: usable, and set up already or able to be. */
export function routeChoosable(route: ProviderRoute): boolean {
    return (
        (route.status === "ready" || route.status === "unknown") &&
        (route.use !== null || route.providerId !== null)
    );
}

/** The provider CLI behind a vendor's own route, when it is one. */
export function routeCli(route: ProviderRoute): ProviderCliId | undefined {
    return route.kind === "direct" || route.kind === "desktop_app"
        ? chatProviderId(route.id)
        : undefined;
}

/** A route as the person knows the AI it reaches: a key for the built-in Claude is still Claude. */
export function routeApp(route: ProviderRoute): string {
    const cli =
        routeCli(route) ??
        (route.providerId === null ? undefined : chatProviderId(route.providerId));
    if (cli !== undefined) return APP_OF[cli];
    return route.vendors.length === 1 ? route.vendors[0]! : route.name;
}

export function routeAccount(route: ProviderRoute): string | undefined {
    const account = route.account;
    if (account === null) return undefined;
    return (
        account.label ?? ([account.email, account.plan].filter(Boolean).join(" · ") || undefined)
    );
}

export function cliAccount(cli: ProviderCli): string | undefined {
    return (
        [cli.signIn.account?.email, cli.signIn.account?.plan].filter(Boolean).join(" · ") ||
        undefined
    );
}

/**
 * The ways this computer already reaches models, as a table to tick: the recommended ones start
 * ticked, so each vendor is reached one way, unless `ticked` keeps what the person last submitted.
 */
export function routesTable(routes: readonly ProviderRoute[], ticked?: readonly string[]): string {
    const checked = (route: ProviderRoute) =>
        ticked === undefined ? route.recommended : ticked.includes(route.id);
    return [
        '<form data-action="onboarding.next" data-step="use" data-table data-columns="Use|AI|Route|Account">',
        ...routes.map((route) => {
            const mark = routeMark(route);
            const overlaps = route.recommended
                ? []
                : routes.filter((other) => route.overlaps.includes(other.id));
            const note =
                route.warning ??
                (overlaps.length > 0
                    ? `Overlaps ${listOf(overlaps.map((other) => other.name))}`
                    : undefined);
            return [
                `  <label${mark === undefined ? "" : ` data-mark="${mark}"`}>`,
                `<input type="checkbox" value="${escape(route.id)}"${checked(route) ? " checked" : ""}>`,
                escape(route.name),
                note === undefined ? "" : ` <small>${escape(note)}</small>`,
                `<small>${escape(routeKind(route))}</small>`,
                `<small>${escape(routeAccount(route) ?? "—")}</small>`,
                "</label>",
            ].join("");
        }),
        '  <button type="submit" data-emphasis>Use selected</button>',
        '  <button type="button" data-action="onboarding.next" data-step="more">Sign in to another AI</button>',
        "</form>",
    ].join("\n");
}

/** Every AI as an equal choice, with a way out when the person has none or wants an API key. */
export function providerMenu(options: { readonly withNone: boolean }): string {
    return [
        "<menu>",
        ...MENU_LABELS.map(
            ({ id, label }) =>
                `  <button data-action="onboarding.next" data-step="choose" data-provider="${id}" data-mark="${MARK_OF[id]}">${escape(label)}</button>`,
        ),
        ...(options.withNone
            ? ['  <button data-action="onboarding.next" data-step="none-yet">None yet</button>']
            : []),
        '  <button data-action="onboarding.next" data-step="other">API key or other</button>',
        "</menu>",
    ].join("\n");
}

/** A command as a fenced block no backtick inside it can close. */
export function codeBlock(command: string): string {
    const longest = Math.max(2, ...[...command.matchAll(/`+/gu)].map((run) => run[0].length));
    const fence = "`".repeat(longest + 1);
    return `${fence}sh\n${command}\n${fence}`;
}

function routeMark(route: ProviderRoute): ChatActionMark | undefined {
    if (route.vendors.length !== 1) return undefined;
    switch (route.vendors[0]) {
        case "Anthropic":
            return "claude";
        case "OpenAI":
            return "openai";
        case "xAI":
            return "grok";
        case "Google":
            return "gemini";
        default:
            return undefined;
    }
}

const KIND_LABELS: Readonly<Record<ProviderRoute["kind"], string>> = {
    direct: "Direct",
    desktop_app: "Desktop app",
    api_key: "API key",
    local_proxy: "Local proxy",
    router: "Router",
    cloud: "Cloud",
    local_models: "Local models",
};

function routeKind(route: ProviderRoute): string {
    // A key billed to a subscription is a sign-in token, such as CLAUDE_CODE_OAUTH_TOKEN.
    if (route.kind === "api_key" && route.billing === "subscription") return "Token";
    const kind = KIND_LABELS[route.kind];
    return route.billing === "pay_per_token" ? `${kind} · pay per token` : kind;
}

function escape(text: string): string {
    return text
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/"/gu, "&quot;")
        .replace(/'/gu, "&#39;");
}
