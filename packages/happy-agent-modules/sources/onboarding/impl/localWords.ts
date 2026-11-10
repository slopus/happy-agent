import type { ProviderCli } from "../../providerClis/index.js";
import type { OnboardingRuntimeOffer } from "./checkOnboardingRecipe.js";

/** What the standalone daemon offers the `local` recipe. */
export const LOCAL_OFFER: OnboardingRuntimeOffer = {
    variables: new Set(["botName", "machine", "provider", "reason", "firstProjectRecipe"]),
    components: new Set(["provider_sign_in"]),
    replies: new Set(["provider"]),
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
        "show_ui",
        "suggest_replies",
    ]),
    requirements: new Set(["provider", "profile"]),
};

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

/**
 * The opening's reply for one AI, worded by its state: "Set up Grok" when it is missing, "Connect
 * Claude Code" when it is signed in already, otherwise "Sign in to Codex". The model words its own
 * replies the same way from the `ais` its events carry.
 */
export function providerReplyText(cli: ProviderCli): string {
    if (cli.installation.status !== "installed") return `Set up ${cli.name}`;
    if (cli.signIn.status === "signed_in") return `Connect ${cli.name}`;
    return `Sign in to ${cli.name}`;
}

export function cliAccount(cli: ProviderCli): string | undefined {
    return (
        [cli.signIn.account?.email, cli.signIn.account?.plan].filter(Boolean).join(" · ") ||
        undefined
    );
}
