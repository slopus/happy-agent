import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { UiSecret } from "../secret.js";
import { uiTimestampSchema } from "../uiValues.js";

/** The codes that download Happy's phone app. */
export const phoneAppComponent = defineUiComponent({
    type: "phone_app",
    description: "The codes that download Happy's phone app.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {},
});

const pairingIdSchema = Type.String({ minLength: 1, maxLength: 64 });

/**
 * This computer's phone pairing, drawn live from the mobile connector. `start` returns the
 * pairing code to the widget alone; `confirm` and `cancel` answer the emoji check.
 */
export const phonePairComponent = defineUiComponent({
    type: "phone_pair",
    description: "This computer's phone pairing, live: start it, show the code, compare the emoji.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {
        start: {
            payload: Type.Object({}, { additionalProperties: false }),
            result: Type.Object(
                {
                    pairingId: pairingIdSchema,
                    /** The text to show as a QR code: a one-time secret, shown only in the widget. */
                    pairing: UiSecret(Type.String({ minLength: 1, maxLength: 8_192 })),
                    expiresAt: uiTimestampSchema,
                },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "config.manage",
        },
        confirm: {
            payload: Type.Object({ pairingId: pairingIdSchema }, { additionalProperties: false }),
            transcript: "silent",
            permission: "config.manage",
        },
        cancel: {
            payload: Type.Object({ pairingId: pairingIdSchema }, { additionalProperties: false }),
            transcript: "silent",
            permission: "config.manage",
        },
    },
});
