import { defineUiComponent, UiSecret } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";

import type { ChatUiModule } from "../../../sources/chatUi/index.js";

/**
 * A component no shipped build has: one outside service's API key, pasted to connect the service
 * and removable again. It exists to show a whole component in one place: several actions, a
 * secret payload field, a typed result, a permission per action, a rejection, and a note that
 * wakes the model. This file is the "Adding a component" walk-through in the module's README.
 */

// 1. The contract every client and the server share: props, and for each action its payload, its
//    result, and the permission the clicking person must hold.
export const serviceKeyComponent = defineUiComponent({
    type: "service_key",
    description: "One outside service's API key: paste it to connect the service, or remove it.",
    props: Type.Object(
        { service: Type.String({ minLength: 1, maxLength: 80 }) },
        { additionalProperties: false },
    ),
    actions: {
        save: {
            payload: Type.Object(
                // A secret is never stored, announced, logged, or given to a model.
                { key: UiSecret(Type.String({ minLength: 1, maxLength: 4_096 })) },
                { additionalProperties: false },
            ),
            // Returned to the caller alone and never stored.
            result: Type.Object({ replaced: Type.Boolean() }, { additionalProperties: false }),
            permission: "providers.own",
        },
        remove: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: "providers.manage",
        },
    },
});

/**
 * 2. The server side, written by the module that does the work and called while modules are
 *    constructed. Answers the keys it holds, so a test can read what each hook received.
 */
export function contributeServiceKey(chatUi: ChatUiModule): Map<string, string> {
    const keys = new Map<string, string>();
    chatUi.contribute(serviceKeyComponent, {
        prompt: "One outside service's API key: the person pastes it to connect the service, or removes it. Show one per service you need a key for. A saved key reaches you as a hidden note, in a turn of its own.",
        fallback: (props) => `Connect ${props.service} in Happy on your computer`,
        actions: {
            save: (_ctx, offer, payload) => {
                // A refusal is the person's answer, not an error: the widget shows the reason.
                if (!payload.key.startsWith("key-")) {
                    return Promise.resolve({
                        status: "rejected",
                        code: "key_rejected",
                        reason: `That doesn't look like a ${offer.props.service} key.`,
                    });
                }
                const replaced = keys.has(offer.props.service);
                keys.set(offer.props.service, payload.key);
                return Promise.resolve({
                    status: "accepted",
                    // The model reads this in a hidden turn that starts now.
                    note: `${offer.props.service} is connected.`,
                    wake: true,
                    result: { replaced },
                });
            },
            remove: (_ctx, offer) => {
                keys.delete(offer.props.service);
                // Without `wake`, the note waits for the conversation's next turn.
                return Promise.resolve({
                    status: "accepted",
                    note: `${offer.props.service} was disconnected.`,
                });
            },
        },
    });
    return keys;
}
