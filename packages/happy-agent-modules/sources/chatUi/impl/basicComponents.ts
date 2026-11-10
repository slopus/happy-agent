import { defaultModelComponent, fileTreeComponent } from "@slopus/happy-agent-client";

import { DefaultModelError, type ConfigModule } from "../../config/index.js";
import type { ChatUiModule } from "../ChatUiModule.js";

/**
 * The components chat UI serves itself: a file tree to look at, and the default model, which lives
 * here because configuration is upstream of chat UI and so cannot contribute it.
 */
export function contributeBasicComponents(chatUi: ChatUiModule, config: ConfigModule): void {
    chatUi.contribute(fileTreeComponent, {
        prompt: "Paths drawn as a file tree, for showing a project's layout or what changed. Nothing in it is pressable.",
        fallback: (props) => props.paths.join(", "),
        actions: {},
    });
    chatUi.contribute(defaultModelComponent, {
        prompt: "The default model for new conversations, live, with a control that changes it. Show it only when the person asks about models.",
        fallback: () => "The default model is in Settings.",
        actions: {
            set: async (ctx, _offer, payload) => {
                try {
                    await config.setDefaultModel(ctx, payload);
                } catch (error: unknown) {
                    if (!(error instanceof DefaultModelError)) throw error;
                    return { status: "rejected", code: "unavailable", reason: error.message };
                }
                return { status: "accepted" };
            },
        },
    });
}
