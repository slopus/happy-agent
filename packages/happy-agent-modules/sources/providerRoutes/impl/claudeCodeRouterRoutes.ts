import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { DetectedRoute } from "./DetectedRoute.js";
import { homeOf, providerIdFrom, type RouteMachine } from "./RouteMachine.js";

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_PROVIDER_MODELS = 200;

/** The part of Claude Code Router's `config.json` this reads; everything else is ignored. */
const routerConfigSchema = Type.Object({
    Providers: Type.Array(
        Type.Object({
            name: Type.String({ minLength: 1, maxLength: 128 }),
            api_base_url: Type.String({ minLength: 1, maxLength: 2_048 }),
            api_key: Type.Optional(Type.String({ maxLength: 4_096 })),
            models: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }))),
        }),
        { maxItems: 100 },
    ),
});

const VENDOR_NAMES: Readonly<Record<string, string>> = {
    deepseek: "DeepSeek",
    gemini: "Google",
    groq: "Groq",
    mistral: "Mistral",
    moonshot: "Moonshot AI",
    ollama: "Ollama",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    siliconflow: "SiliconFlow",
    volcengine: "Volcengine",
};

/**
 * The upstream providers a Claude Code Router configuration lists, one route each. Happy talks to
 * each upstream directly rather than through the router, since it already translates between
 * vendors itself. Only OpenAI-compatible upstreams, whose URL ends in `/chat/completions`, can be
 * set up; the key is copied, or referenced when the router reads it from a variable.
 *
 * Recent releases keep their configuration in a SQLite database whose layout is not documented;
 * only the `config.json` that earlier releases wrote, and that later ones migrate from, is read.
 */
export async function claudeCodeRouterRoutes(machine: RouteMachine): Promise<DetectedRoute[]> {
    const path = join(homeOf(machine), ".claude-code-router", "config.json");
    let text: string;
    try {
        if ((await stat(path)).size > MAX_CONFIG_BYTES) return [];
        text = await readFile(path, "utf8");
    } catch {
        return [];
    }
    let config: unknown;
    try {
        config = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Value.Check(routerConfigSchema, config)) return [];
    const seen = new Set<string>();
    return config.Providers.flatMap((upstream): DetectedRoute[] => {
        const id = `ccr:${upstream.name}`;
        if (seen.has(id)) return [];
        seen.add(id);
        const vendor = VENDOR_NAMES[upstream.name.toLowerCase()] ?? upstream.name;
        const baseUrl = /^(https?:\/\/\S+?)\/chat\/completions\/?$/u.exec(
            upstream.api_base_url,
        )?.[1];
        const local = /^https?:\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/u.test(upstream.api_base_url);
        const models = (upstream.models ?? []).slice(0, MAX_PROVIDER_MODELS);
        const key = upstream.api_key?.trim() ?? "";
        const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(key)?.[1];
        // A key the router reads from a variable works here only when the daemon has it too.
        const keyAvailable =
            variable === undefined
                ? key.length > 0 || local
                : (machine.env[variable]?.trim().length ?? 0) > 0;
        const usable = baseUrl !== undefined && models.length > 0 && keyAvailable;
        return [
            {
                id,
                kind: "router",
                name: `${vendor} from Claude Code Router`,
                vendors: [vendor],
                billing: local ? "local" : "pay_per_token",
                account: null,
                endpoint: local && baseUrl !== undefined ? baseUrl : null,
                status: "ready",
                models: models.length === 0 ? null : models.map((model) => ({ id: model, vendor })),
                warning: null,
                ...(!usable
                    ? {}
                    : {
                          provider: {
                              id: providerIdFrom("ccr", upstream.name),
                              table: {
                                  type: "openai_compatible",
                                  name: vendor,
                                  base_url: baseUrl,
                                  ...(variable !== undefined
                                      ? { api_key_env: variable }
                                      : { api_key: key.length > 0 ? key : "local" }),
                                  models,
                              },
                              summary: `Adds ${vendor} with the settings from Claude Code Router.`,
                          },
                      }),
            },
        ];
    });
}
