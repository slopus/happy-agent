import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { ConfigModule } from "../ConfigModule.js";

const reloadConfigurationInputSchema = Type.Object({}, { additionalProperties: false });

const reloadConfigurationResultSchema = Type.Union([
    Type.Object(
        {
            reloaded: Type.Literal(true),
            /** Top-level sections whose values differ from before the reload. */
            changed: Type.Array(Type.String()),
            /** Changed sections the running daemon applies only after a restart. */
            requiresRestart: Type.Array(Type.String()),
            /** Settings the files name that the daemon does not know and ignored. */
            warnings: Type.Array(Type.String()),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            reloaded: Type.Literal(false),
            /** Why the files could not be applied. The previous configuration is still in effect. */
            errors: Type.Array(Type.String()),
        },
        { additionalProperties: false },
    ),
]);

/**
 * Re-read `happy.toml` and apply it to the running daemon.
 *
 * This is how an agent that edited the configuration — set a Codex `base_url`, pointed
 * `auth_file` somewhere, added a provider — makes the edit count without asking anyone to restart
 * the daemon. Nothing is inferred from other tools' files: the settings live in `happy.toml` and
 * this applies exactly what is written there.
 */
export function createReloadConfigurationTool(config: ConfigModule) {
    return defineAgentTool({
        name: "reload_configuration",
        defer: true,
        capabilities: [
            "Reload Happy Agent configuration from happy.toml without restarting the daemon.",
        ],
        searchKeywords: [
            "reload config",
            "apply happy.toml",
            "reload happy.toml",
            "refresh configuration",
        ],
        description:
            "Re-reads the Happy Agent configuration files (the user happy.toml, the project happy.toml, and the generated runtime.toml) and applies them to the running daemon. Provider settings such as base_url, api_key, and auth_file take effect for the next request; the result lists any changed sections that still need a daemon restart. If a file is invalid nothing changes and the errors are returned.",
        parameters: reloadConfigurationInputSchema,
        returnType: reloadConfigurationResultSchema,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "This re-reads the Happy configuration files and rebuilds provider accounts from them.",
        describeAutoPermissionAction: () =>
            "reloading Happy Agent configuration from happy.toml and rebuilding provider accounts",
        shouldReviewInAutoMode: () => true,
        execute: async (ctx): Promise<Static<typeof reloadConfigurationResultSchema>> => {
            const result = await config.reload(ctx);
            if (result.status === "invalid") {
                return { reloaded: false, errors: Array.from(result.errors) };
            }
            return {
                reloaded: true,
                changed: Array.from(result.changed),
                requiresRestart: Array.from(result.requiresRestart),
                warnings: Array.from(result.warnings),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: result.reloaded
                    ? [
                          result.changed.length === 0
                              ? "Configuration reloaded; nothing changed."
                              : `Configuration reloaded. Changed: ${result.changed.join(", ")}.`,
                          result.requiresRestart.length === 0
                              ? ""
                              : `These sections take effect only after the daemon restarts: ${result.requiresRestart.join(", ")}.`,
                          result.warnings.length === 0 ? "" : result.warnings.join(" "),
                      ]
                          .filter((line) => line.length > 0)
                          .join("\n")
                    : `The configuration could not be reloaded and the previous configuration is still in effect:\n${result.errors.join("\n")}`,
            },
        ],
    });
}
