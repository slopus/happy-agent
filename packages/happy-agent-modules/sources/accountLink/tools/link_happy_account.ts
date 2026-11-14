import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { accountLinkStatusSchema } from "../AccountLink.js";
import type { AccountLinkModule } from "../AccountLinkModule.js";
import { formatAccountLinkStatus } from "./accountLinkToolOutput.js";

/** Start linking this installation to a Happy account with a code a person approves. */
export function linkHappyAccountTool(accountLink: AccountLinkModule, actingAgentId: string) {
    return defineAgentTool({
        name: "link_happy_account",
        defer: true,
        capabilities: ["Link this computer to a Happy account and control its relay reachability."],
        searchKeywords: ["link Happy account", "device code", "connect computer to account"],
        description:
            "Start linking this Happy Agent installation to a Happy account. Returns a short code and a URL; the person approves the code in a browser signed in to their Happy account, and that account becomes this computer's owner. Linking alone does not make the computer reachable. Calling it again while a code is waiting returns the same code.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: accountLinkStatusSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Linking chooses the Happy account that owns this computer: whoever approves the code can later be given full access to this Happy Agent API through the Happy Relay. Only the person using this computer should receive the code.",
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "starting to link this Happy Agent installation to a Happy account that will own it",
        execute: async (ctx) => await accountLink.startLink(ctx, actingAgentId),
        toLLM: (status) => [{ type: "text", text: formatAccountLinkStatus(status) }],
    });
}
