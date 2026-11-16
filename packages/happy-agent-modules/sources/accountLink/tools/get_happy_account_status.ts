import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { accountLinkStatusSchema } from "../AccountLink.js";
import type { AccountLinkModule } from "../AccountLinkModule.js";
import { formatAccountLinkStatus } from "./accountLinkToolOutput.js";

/** Read whether this installation is linked to a Happy account and reachable through the relay. */
export function getHappyAccountStatusTool(accountLink: AccountLinkModule, actingAgentId: string) {
    return defineAgentTool({
        name: "get_happy_account_status",
        defer: true,
        capabilities: ["Link this computer to a Happy account and control its relay reachability."],
        searchKeywords: ["Happy account link status", "relay reachable", "link code"],
        description:
            "Read whether this Happy Agent installation is linked to a Happy account, whether a link code is waiting for approval, and whether its owner can reach it through the Happy Relay.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: accountLinkStatusSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx) => await accountLink.getStatus(ctx, actingAgentId),
        toLLM: (status) => [{ type: "text", text: formatAccountLinkStatus(status) }],
    });
}
