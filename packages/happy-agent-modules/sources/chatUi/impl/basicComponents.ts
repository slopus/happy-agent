import {
    checklistComponent,
    choiceComponent,
    defaultModelComponent,
    fileTreeComponent,
    textFieldComponent,
} from "@slopus/happy-agent-client";

import { DefaultModelError, type ConfigModule } from "../../config/index.js";
import type { ChatUiModule } from "../ChatUiModule.js";

/**
 * The components chat UI serves itself: the answers a person gives the model (`choice`,
 * `checklist`, `text_field`), a file tree to look at, and the default model, which lives here
 * because configuration is upstream of chat UI. An accepted answer becomes the person's words with
 * no further work: the words are the stored labels, never text from the request.
 */
export function contributeBasicComponents(chatUi: ChatUiModule, config: ConfigModule): void {
    chatUi.contribute(choiceComponent, {
        prompt: "Up to six buttons for one question; one may be primary, the step you recommend. A press sends the option's label as the person's message, and the offer closes once answered or once they type.",
        fallback: (props) => props.options.map((option) => option.label).join(" · "),
        guestSafe: true,
        actions: { choose: async () => ({ status: "accepted" }) },
    });
    chatUi.contribute(checklistComponent, {
        prompt: "Options the person ticks, then submits with submitLabel; `checked` ticks one in advance. The submission reaches you as their message: the submit label and the ticked labels, or emptyLabel when nothing is ticked.",
        fallback: (props) =>
            `${props.options.map((option) => option.label).join(", ")} · ${props.submitLabel}`,
        guestSafe: true,
        actions: { submit: async () => ({ status: "accepted" }) },
    });
    chatUi.contribute(textFieldComponent, {
        prompt: "A one-field answer, such as a nickname or a repository address. What they type reaches you as their message.",
        fallback: (props) => props.label,
        guestSafe: true,
        actions: { submit: async () => ({ status: "accepted" }) },
    });
    chatUi.contribute(fileTreeComponent, {
        prompt: "Paths drawn as a file tree, for showing a project's layout or what changed. Nothing in it is pressable.",
        fallback: (props) => props.paths.join(", "),
        guestSafe: true,
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
