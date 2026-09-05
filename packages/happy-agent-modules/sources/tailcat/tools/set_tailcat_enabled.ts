import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { tailcatStatusSchema } from "../Tailcat.js";
import type { TailcatModule } from "../TailcatModule.js";
import { formatTailcatStatus } from "./tailcatToolOutput.js";

const setTailcatEnabledInputSchema = Type.Object(
    { enabled: Type.Boolean() },
    { additionalProperties: false },
);
type SetTailcatEnabledInput = Static<typeof setTailcatEnabledInputSchema>;

/** Persist and immediately reconcile this installation's Tailcat internet exposure. */
export function setTailcatEnabledTool(tailcat: TailcatModule, actingAgentId: string) {
    return defineAgentTool({
        name: "set_tailcat_enabled",
        defer: true,
        capabilities: ["Enable, disable, and inspect Tailcat internet exposure."],
        searchKeywords: ["enable Tailcat", "disable internet tunnel", "expose team server"],
        description:
            "Enable or disable Tailcat internet exposure for this Happy Agent installation. Enabling opens an account-free Tailcat tunnel around the active API transport and keeps its stable identity across restarts. Happy Agent API authentication remains in force.",
        parameters: setTailcatEnabledInputSchema,
        returnType: tailcatStatusSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Enabling Tailcat makes this Happy Agent API reachable from the internet through an account-free tunnel. Disabling it closes that tunnel.",
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: ({ enabled }: SetTailcatEnabledInput) =>
            enabled
                ? "opening account-free Tailcat internet exposure for this Happy Agent API"
                : "closing this Happy Agent installation's Tailcat internet exposure",
        execute: async (ctx, { enabled }: SetTailcatEnabledInput) =>
            await tailcat.setEnabled(ctx, actingAgentId, enabled),
        toLLM: (status) => [{ type: "text", text: formatTailcatStatus(status) }],
    });
}

export { setTailcatEnabledInputSchema };
