import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import type { UiPermission } from "../permission.js";
import { UiSecret } from "../secret.js";
import { uiProviderSchema } from "../uiValues.js";

/** Signing in for the team needs `providers.manage`; for yourself, `providers.own`. */
const byTarget: UiPermission = {
    prop: "target",
    map: { team: "providers.manage", private: "providers.own" },
    default: "providers.own",
};

/**
 * One AI's install and sign-in, drawn live from the server's provider CLI state: install, sign in
 * in the browser, paste a sign-in code, or paste a setup token or API key. On a signed-in AI,
 * `sign_in` connects it as it is.
 */
export const providerSignInComponent = defineUiComponent({
    type: "provider_sign_in",
    description:
        "One AI's install and sign-in, live: install, sign in, paste a code, a setup token, or a key.",
    props: Type.Object(
        {
            provider: uiProviderSchema,
            /** Whose connection a sign-in makes, on a team server; absent means `private`. */
            target: Type.Optional(Type.Union([Type.Literal("team"), Type.Literal("private")])),
        },
        { additionalProperties: false },
    ),
    actions: {
        install: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: "providers.manage",
        },
        sign_in: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: byTarget,
        },
        submit_code: {
            payload: Type.Object(
                { code: UiSecret(Type.String({ minLength: 1, maxLength: 2_048 })) },
                { additionalProperties: false },
            ),
            permission: byTarget,
        },
        submit_token: {
            payload: Type.Object(
                { token: UiSecret(Type.String({ minLength: 1, maxLength: 4_096 })) },
                { additionalProperties: false },
            ),
            permission: byTarget,
        },
        cancel: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: byTarget,
        },
    },
});
