import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { accountLinkStatusSchema } from "../AccountLink.js";
import type { AccountLinkModule } from "../AccountLinkModule.js";
import { formatAccountLinkStatus } from "./accountLinkToolOutput.js";

const setHappyAccountReachableInputSchema = Type.Object(
    { reachable: Type.Boolean() },
    { additionalProperties: false },
);
type SetHappyAccountReachableInput = Static<typeof setHappyAccountReachableInputSchema>;

/** Persist and immediately reconcile whether the owner can reach this installation. */
export function setHappyAccountReachableTool(
    accountLink: AccountLinkModule,
    actingAgentId: string,
) {
    return defineAgentTool({
        name: "set_happy_account_reachable",
        defer: true,
        capabilities: ["Link this computer to a Happy account and control its relay reachability."],
        searchKeywords: ["make computer reachable", "Happy Relay", "remote access from phone"],
        description:
            "Make this linked Happy Agent installation reachable through the Happy Relay, or stop that. While reachable, the daemon keeps one outbound connection to the relay and the owning Happy account can use the whole Happy Agent API from anywhere. Turning it off closes the connection at once. The choice survives restarts.",
        parameters: setHappyAccountReachableInputSchema,
        returnType: accountLinkStatusSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Making this computer reachable exposes this Happy Agent API to the internet through the Happy Relay for the linked Happy account. Turning it off closes that path.",
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: ({ reachable }: SetHappyAccountReachableInput) =>
            reachable
                ? "opening this Happy Agent API to its linked Happy account through the Happy Relay on the internet"
                : "closing this Happy Agent installation's Happy Relay connection",
        execute: async (ctx, { reachable }: SetHappyAccountReachableInput) =>
            await accountLink.setReachable(ctx, actingAgentId, reachable),
        toLLM: (status) => [{ type: "text", text: formatAccountLinkStatus(status) }],
    });
}

export { setHappyAccountReachableInputSchema };
