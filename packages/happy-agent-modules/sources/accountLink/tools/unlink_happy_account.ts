import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { accountLinkStatusSchema } from "../AccountLink.js";
import type { AccountLinkModule } from "../AccountLinkModule.js";
import { formatAccountLinkStatus } from "./accountLinkToolOutput.js";

/** Remove this installation's link to its Happy account and close its relay connection. */
export function unlinkHappyAccountTool(accountLink: AccountLinkModule, actingAgentId: string) {
    return defineAgentTool({
        name: "unlink_happy_account",
        defer: true,
        capabilities: ["Link this computer to a Happy account and control its relay reachability."],
        searchKeywords: ["unlink Happy account", "remove computer from account", "cancel link"],
        description:
            "Unlink this Happy Agent installation from its Happy account. Closes the Happy Relay connection at once, marks the computer unreachable and revokes its credential at Happy accounts, deletes the stored credential, and cancels a link code that is still waiting. The computer stays listed in the account until its owner removes it there. Linking again needs a new approval.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: accountLinkStatusSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Unlinking closes this computer's Happy Relay connection and revokes its Happy account credential. The owner loses remote access until someone links it again.",
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "unlinking this Happy Agent installation from its Happy account and closing its Happy Relay connection",
        execute: async (ctx) => await accountLink.unlink(ctx, actingAgentId),
        toLLM: (status) => [{ type: "text", text: formatAccountLinkStatus(status) }],
    });
}
