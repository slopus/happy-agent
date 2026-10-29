import type { ProviderCli } from "../../providerClis/index.js";
import type { ProviderRoute } from "../../providerRoutes/index.js";
import type { ChatProviderChoice, ChatProviderId } from "./chatActions/chatAction.js";
import {
    chatActionEscape,
    chatActionSegments,
    type ChatActionMark,
} from "./chatActions/chatActionBlocks.js";

/**
 * Happy's own words before a provider is connected, in the inline action grammar. The desktop's
 * flow on `chat-onboarding` is the reference for their wording.
 */

export const PROVIDER_OF: Record<Exclude<ChatProviderChoice, "none" | "other">, ChatProviderId> = {
    claude: "claude",
    chatgpt: "codex",
    grok: "grok",
    gemini: "antigravity",
};

export const MARK_OF: Record<ChatProviderId, ChatActionMark> = {
    claude: "claude",
    codex: "openai",
    grok: "grok",
    antigravity: "gemini",
};

/** Each AI as the person knows it. */
export const APP_OF: Record<ChatProviderId, string> = {
    claude: "Claude",
    codex: "ChatGPT",
    grok: "Grok",
    antigravity: "Gemini",
};

export const PROVIDER_BUTTONS: readonly {
    readonly choice: ChatProviderChoice;
    readonly label: string;
    readonly mark?: ChatActionMark;
}[] = [
    { choice: "claude", label: "Claude", mark: "claude" },
    { choice: "chatgpt", label: "ChatGPT", mark: "openai" },
    { choice: "grok", label: "Grok", mark: "grok" },
    { choice: "gemini", label: "Gemini (Antigravity)", mark: "gemini" },
    { choice: "none", label: "None yet" },
    { choice: "other", label: "API key or something else" },
];

const FIRST_STEP =
    "First, let's check which AI subscriptions you already use. I reuse what you pay for today, so there's nothing new to pay for.";

/** Said once, under the subscriptions Happy found: connecting more never has to happen now. */
const CONNECT_LATER =
    '<output data-status="info">You can always ask me to connect more later.</output>';

/** The desktop model picker's own labels (`happyAgentThinkingLabel`), so both read the same. */
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
    return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** "Mac" on a Mac; "computer" anywhere else. */
export function machineWord(platform: NodeJS.Platform): string {
    return platform === "darwin" ? "Mac" : "computer";
}

export function menu(...buttons: readonly string[]): string {
    return ["<menu>", ...buttons.map((button) => `  ${button}`), "</menu>"].join("\n");
}

export function listOf(words: readonly string[], conjunction: "and" | "or" = "and"): string {
    if (words.length <= 2) return words.join(` ${conjunction} `);
    return `${words.slice(0, -1).join(", ")}, ${conjunction} ${words[words.length - 1]!}`;
}

/** Happy introduces itself and the example sidebar, and offers to start. */
export function openingMessage(): string {
    return [
        "Hi, I'm Happy, your main agent. I run and coordinate agents across your work. The sidebar shows an example of what that looks like.",
        "",
        menu('<button data-action="onboarding.start" data-emphasis>Start onboarding</button>'),
    ].join("\n");
}

/** Every AI as an equal choice: no vendor is favoured. */
export function providerMenu(options: { readonly withNone: boolean }): string {
    return menu(
        ...PROVIDER_BUTTONS.filter((button) => options.withNone || button.choice !== "none").map(
            (button) =>
                `<button data-action="onboarding.provider" data-provider="${button.choice}"${button.mark ? ` data-mark="${button.mark}"` : ""}>${chatActionEscape(button.label)}</button>`,
        ),
    );
}

/** Whether the person can choose a route now: usable, and set up already or able to be. */
export function routeChoosable(route: ProviderRoute): boolean {
    return (
        (route.status === "ready" || route.status === "unknown") &&
        (route.use !== null || route.providerId !== null)
    );
}

/**
 * The first step: the subscriptions this computer already uses, as a table to tick, or the AIs
 * to choose from when it uses none.
 */
export function subscriptionsMessage(
    routes: readonly ProviderRoute[],
    signedIn: readonly ProviderCli[],
    machine: string,
): string {
    if (routes.length > 0) {
        return `${FIRST_STEP} I found these on this ${machine}; choose which ones I should use.\n\n${routesTable(routes)}\n\n${CONNECT_LATER}`;
    }
    if (signedIn.length === 0) {
        return [
            `${FIRST_STEP} I didn't find any signed in on this ${machine}. Which do you use?`,
            "",
            providerMenu({ withNone: true }),
            "",
            '<output data-status="info">Nothing is connected yet.</output>',
        ].join("\n");
    }
    return `${FIRST_STEP} I found these on this ${machine}; choose which ones I should use.\n\n${providersTable(signedIn)}\n\n${CONNECT_LATER}`;
}

export function accountOf(cli: ProviderCli): string {
    return [cli.signIn.account?.email, cli.signIn.account?.plan].filter(Boolean).join(" · ");
}

/**
 * The accounts signed in on this machine, every one ticked. A second account of the same AI is
 * not offered until more than one can be used.
 */
export function providersTable(signedIn: readonly ProviderCli[]): string {
    return [
        '<form data-action="onboarding.providersUse" data-table>',
        ...signedIn.flatMap((cli) => {
            const id = chatProviderId(cli.id);
            if (id === undefined) return [];
            return [
                `  <label data-mark="${MARK_OF[id]}"><input type="checkbox" value="${id}" checked>${chatActionEscape(APP_OF[id])} <small>${chatActionEscape(cli.name)}</small><small>${chatActionEscape(accountOf(cli) || "Signed in")}</small><small>${chatActionEscape(`${APP_OF[id]} subscription`)}</small></label>`,
            ];
        }),
        '  <button type="submit" data-emphasis>Use selected</button>',
        '  <button type="button" data-action="onboarding.connectAnother">Sign in to more</button>',
        "</form>",
    ].join("\n");
}

/**
 * The ways this computer already reaches models: the recommended ones start ticked, so each
 * vendor is reached one way, and one that reaches what another already does says so.
 */
export function routesTable(routes: readonly ProviderRoute[]): string {
    return [
        '<form data-action="onboarding.routesUse" data-table>',
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
            return `  <label${mark ? ` data-mark="${mark}"` : ""}><input type="checkbox" value="${chatActionEscape(route.id)}"${route.recommended ? " checked" : ""}>${chatActionEscape(route.name)} ${note ? `<small>${chatActionEscape(note)}</small>` : ""}<small>${chatActionEscape(routeKindLabel(route))}</small><small>${chatActionEscape(routeAccountLabel(route) ?? "—")}</small></label>`;
        }),
        '  <button type="submit" data-emphasis>Use selected</button>',
        '  <button type="button" data-action="onboarding.connectAnother">Sign in to more</button>',
        "</form>",
    ].join("\n");
}

export function chatProviderId(id: string): ChatProviderId | undefined {
    return id === "claude" || id === "codex" || id === "grok" || id === "antigravity"
        ? id
        : undefined;
}

/** A route's mark when it serves one vendor whose mark Happy draws. */
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

const KIND_LABELS: Readonly<Record<string, string>> = {
    direct: "Direct",
    desktop_app: "Desktop app",
    api_key: "API key",
    local_proxy: "Local proxy",
    router: "Router",
    cloud: "Cloud",
    local_models: "Local models",
};

function routeKindLabel(route: ProviderRoute): string {
    const kind = KIND_LABELS[route.kind] ?? "Other";
    return route.billing === "pay_per_token" ? `${kind} · pay per token` : kind;
}

function routeAccountLabel(route: ProviderRoute): string | undefined {
    const account = route.account;
    if (account === null) return undefined;
    const named =
        account.label ?? ([account.email, account.plan].filter(Boolean).join(" · ") || undefined);
    if (account.count !== null)
        return named
            ? `${named} + ${String(account.count - 1)} more`
            : `${String(account.count)} accounts`;
    return named;
}

/** How much of a message is prose, typed out before its first action block lays down whole. */
export function proseLength(text: string): number {
    let length = 0;
    for (const segment of chatActionSegments(text)) {
        if (segment.type === "actions") break;
        length += segment.text.length;
    }
    return text.slice(0, length).trimEnd().length;
}
