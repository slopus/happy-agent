import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { UiSecret } from "../secret.js";
import { uiProviderSchema } from "../uiValues.js";

/**
 * One AI's install and sign-in, drawn live from the server's provider CLI state: install, sign in
 * in the browser, paste a sign-in code, or paste a setup token or API key where the provider CLI
 * says `signIn.acceptsToken`. An AI that is signed in already shows as done with no control;
 * `sign_in` on it still answers `{ connected: true }` and starts nothing.
 */
export const providerSignInComponent = defineUiComponent({
    type: "provider_sign_in",
    description:
        "One AI's install and sign-in, live: install, sign in, paste a code, a setup token, or a key.",
    props: Type.Object({ provider: uiProviderSchema }, { additionalProperties: false }),
    actions: {
        install: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: "providers.manage",
        },
        sign_in: {
            payload: Type.Object({}, { additionalProperties: false }),
            result: Type.Object(
                {
                    /**
                     * `true` when the AI was signed in already, so nothing was started; `false`
                     * when a sign-in started, which the widget follows in the live state.
                     */
                    connected: Type.Boolean(),
                },
                { additionalProperties: false },
            ),
            permission: "providers.own",
        },
        submit_code: {
            payload: Type.Object(
                { code: UiSecret(Type.String({ minLength: 1, maxLength: 2_048 })) },
                { additionalProperties: false },
            ),
            permission: "providers.own",
        },
        submit_token: {
            payload: Type.Object(
                { token: UiSecret(Type.String({ minLength: 1, maxLength: 4_096 })) },
                { additionalProperties: false },
            ),
            permission: "providers.own",
        },
        cancel: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: "providers.own",
        },
    },
});
