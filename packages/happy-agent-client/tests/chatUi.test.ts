import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
    UiSecret,
    defineUiComponent,
    redactUiValue,
    uiActionDefinition,
    uiActionPermission,
    uiComponents,
} from "../sources/index.js";

describe("chat UI bundles", () => {
    it("refuses a secret on an action that becomes the person's words", () => {
        expect(() =>
            defineUiComponent({
                type: "leaky",
                description: "A field whose secret would become someone's words.",
                props: Type.Object({}),
                actions: {
                    submit: {
                        payload: Type.Object({ token: UiSecret(Type.String()) }),
                        transcript: "message",
                    },
                },
            }),
        ).toThrow("can't carry a secret");
    });

    it("keeps no secret in any message action of the catalog", () => {
        for (const bundle of uiComponents) {
            for (const [name, action] of Object.entries(bundle.actions)) {
                if (action.transcript !== "message") continue;
                expect(redactUiValue(action.payload, {}), `${bundle.type}.${name}`).toEqual({});
            }
        }
    });

    it("leaves undeclared fields and secrets out of a stored payload", () => {
        const found = uiActionDefinition("provider_sign_in.submit_token")!;
        expect(
            redactUiValue(found.definition.payload, { token: "sk-ant-oat01-x", smuggled: "y" }),
        ).toEqual({});
    });

    it("chooses a sign-in's permission by its target", () => {
        const signIn = uiActionDefinition("provider_sign_in.sign_in")!.definition;
        expect(uiActionPermission(signIn, { provider: "claude", target: "team" })).toBe(
            "providers.manage",
        );
        expect(uiActionPermission(signIn, { provider: "claude" })).toBe("providers.own");
    });
});
