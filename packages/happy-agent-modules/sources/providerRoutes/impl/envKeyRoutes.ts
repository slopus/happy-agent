import type { DetectedRoute } from "./DetectedRoute.js";
import type { RouteMachine } from "./RouteMachine.js";

/** A key a built-in provider reads from the environment when its configuration names none. */
interface BuiltInKey {
    readonly variable: string;
    readonly providerId: "claude" | "codex" | "grok";
    readonly name: string;
    readonly vendor: string;
    readonly billing: "subscription" | "pay_per_token";
    /** Whether the provider prefers this key over its CLI's sign-in. */
    readonly outranksSignIn: boolean;
    readonly signInName: string;
}

const BUILT_IN_KEYS: readonly BuiltInKey[] = [
    {
        variable: "CLAUDE_CODE_OAUTH_TOKEN",
        providerId: "claude",
        name: "Claude Code token",
        vendor: "Anthropic",
        billing: "subscription",
        outranksSignIn: true,
        signInName: "Claude Code sign-in",
    },
    {
        variable: "ANTHROPIC_API_KEY",
        providerId: "claude",
        name: "Anthropic API key",
        vendor: "Anthropic",
        billing: "pay_per_token",
        outranksSignIn: true,
        signInName: "Claude Code sign-in",
    },
    {
        // A ChatGPT sign-in outranks this key, so it is used only while Codex is signed out.
        variable: "OPENAI_API_KEY",
        providerId: "codex",
        name: "OpenAI API key",
        vendor: "OpenAI",
        billing: "pay_per_token",
        outranksSignIn: false,
        signInName: "ChatGPT sign-in",
    },
    {
        variable: "XAI_API_KEY",
        providerId: "grok",
        name: "xAI API key",
        vendor: "xAI",
        billing: "pay_per_token",
        outranksSignIn: true,
        signInName: "Grok sign-in",
    },
];

/** An OpenAI-compatible vendor whose key in the environment becomes a provider of its own. */
interface CompatibleVendor {
    readonly variable: string;
    readonly providerId: string;
    readonly name: string;
    readonly baseUrl: string;
    /** The curated models Happy Agent adds; empty when there is no curated catalog yet. */
    readonly models: readonly string[];
    readonly reasoningField?: "reasoning" | "reasoning_content";
}

const COMPATIBLE_VENDORS: readonly CompatibleVendor[] = [
    {
        variable: "OPENROUTER_API_KEY",
        providerId: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        models: ["openai/gpt-6.1-terra", "deepseek/deepseek-v4.1-flash-1017"],
        reasoningField: "reasoning",
    },
    {
        variable: "DEEPSEEK_API_KEY",
        providerId: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", "deepseek-reasoner"],
        reasoningField: "reasoning_content",
    },
    {
        variable: "MISTRAL_API_KEY",
        providerId: "mistral",
        name: "Mistral",
        baseUrl: "https://api.mistral.ai/v1",
        models: ["mistral-large-latest", "codestral-latest"],
    },
    {
        variable: "GROQ_API_KEY",
        providerId: "groq",
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        models: [],
    },
    {
        variable: "TOGETHER_API_KEY",
        providerId: "together",
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        models: [],
    },
    {
        variable: "FIREWORKS_API_KEY",
        providerId: "fireworks",
        name: "Fireworks AI",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        models: [],
    },
    {
        variable: "MOONSHOT_API_KEY",
        providerId: "moonshot",
        name: "Moonshot AI",
        baseUrl: "https://api.moonshot.ai/v1",
        models: [],
    },
];

/**
 * API keys in the daemon's own process environment. Only the variable's presence is read; its
 * value never leaves the environment, and no shell is run to find keys a profile exports.
 *
 * `ambient(providerId)` says whether that built-in provider takes its credentials from the
 * environment, which it does unless its configuration names a key, token, or folder.
 * `signedIn(providerId)` says whether that provider's CLI sign-in is ready, so a key that quietly
 * takes its place can say so.
 */
export function envKeyRoutes(
    machine: RouteMachine,
    ambient: (providerId: string) => boolean,
    signedIn: (providerId: string) => boolean,
): DetectedRoute[] {
    const present = (variable: string) => (machine.env[variable]?.trim().length ?? 0) > 0;
    const builtIn = BUILT_IN_KEYS.filter((key) => present(key.variable)).map(
        (key): DetectedRoute => {
            // Claude reads its OAuth token before its API key, so only the first present one is used.
            const shadowedByToken =
                key.variable === "ANTHROPIC_API_KEY" && present("CLAUDE_CODE_OAUTH_TOKEN");
            const used = ambient(key.providerId) && !shadowedByToken;
            return {
                id: `env:${key.variable}`,
                kind: "api_key",
                name: key.name,
                vendors: [key.vendor],
                billing: key.billing,
                account: null,
                endpoint: null,
                status: "ready",
                models: null,
                warning:
                    used && key.outranksSignIn && signedIn(key.providerId)
                        ? key.billing === "pay_per_token"
                            ? `${key.variable} is set, so ${key.vendor} is billed per token through this key instead of your ${key.signInName}.`
                            : `${key.variable} is set, so this token is used instead of your ${key.signInName}.`
                        : null,
                ...(used ? { providerId: key.providerId } : {}),
            };
        },
    );
    const compatible = COMPATIBLE_VENDORS.filter((vendor) => present(vendor.variable)).map(
        (vendor): DetectedRoute => ({
            id: `env:${vendor.variable}`,
            kind: "api_key",
            name: `${vendor.name} API key`,
            vendors: [vendor.name],
            billing: "pay_per_token",
            account: null,
            endpoint: null,
            status: "ready",
            models:
                vendor.models.length === 0
                    ? null
                    : vendor.models.map((id) => ({ id, vendor: vendor.name })),
            warning: null,
            ...(vendor.models.length === 0
                ? {}
                : {
                      provider: {
                          id: vendor.providerId,
                          table: {
                              type: "openai_compatible",
                              name: vendor.name,
                              base_url: vendor.baseUrl,
                              api_key_env: vendor.variable,
                              models: [...vendor.models],
                              ...(vendor.reasoningField === undefined
                                  ? {}
                                  : { reasoning_field: vendor.reasoningField }),
                          },
                          summary: `Adds ${vendor.name} with the key in ${vendor.variable}.`,
                      },
                  }),
        }),
    );
    return [...builtIn, ...compatible];
}
