import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { localProfileSchema } from "../LocalProfile.js";
import type { ProfileModule } from "../ProfileModule.js";

export function getLocalProfileTool(module: ProfileModule, actingAgentId: string) {
    return defineAgentTool({
        name: "get_local_profile",
        defer: true,
        capabilities: ["Read the local profile for remote deployment."],
        searchKeywords: ["local name and email", "profile bootstrap", "remote onboarding"],
        description:
            "Read this standalone installation's current profile name and email. Copy these values into the remote machine's [profile] table in happy.toml before startup to avoid manual profile creation. Returns null for missing fields; never invent missing values. Only an active admin bot running as a root agent may use this tool. No API request or credentials are involved.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: localProfileSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await module.getLocalProfileForAdmin(ctx, actingAgentId),
        toLLM: (profile) => [{ type: "text", text: JSON.stringify(profile) }],
    });
}
