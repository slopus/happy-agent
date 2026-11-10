import { providerReply } from "@slopus/happy-agent-client";

import type { ChatUiModule } from "../../chatUi/index.js";
import { PROVIDER_CLI_IDS } from "../ProviderCli.js";

/**
 * Serve the `provider` reply component: an AI's mark and its live install and sign-in state beside
 * a quick reply. Clients read that state from the provider CLIs themselves; the model only names
 * the AI.
 */
export function contributeProviderReply(chatUi: ChatUiModule): void {
    chatUi.contributeReply(providerReply, {
        prompt: 'The AI\'s mark before the text and its live state after it: "Not installed", "Not signed in", or how many accounts it has. Put it on options that choose an AI to set up or to add an account to, and write the text as what the tap does, such as "Set up Claude".',
        check: async (_ctx, props) =>
            (PROVIDER_CLI_IDS as readonly string[]).includes(props.provider)
                ? []
                : [`There is no AI "${props.provider}" here.`],
    });
}
