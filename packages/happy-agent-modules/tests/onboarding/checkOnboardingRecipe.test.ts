import { describe, expect, it } from "vitest";

import {
    assertOnboardingRecipe,
    checkOnboardingRecipe,
    type OnboardingRuntimeOffer,
} from "../../sources/onboarding/impl/checkOnboardingRecipe.js";
import { fillRecipeText } from "../../sources/onboarding/impl/fillRecipeText.js";

const OFFER: OnboardingRuntimeOffer = {
    variables: new Set(["provider", "reason"]),
    components: new Set(["provider_sign_in"]),
    tools: new Set(["save_profile", "show_ui"]),
    requirements: new Set(["provider"]),
};

/** A recipe that runs, changed by `change`. */
function recipe(change: (recipe: Record<string, any>) => void = () => {}): unknown {
    const value: Record<string, any> = {
        id: "small",
        version: 1,
        requirements: ["provider"],
        bootstrap: {
            say: "Connect the AI you use.",
            offer: ["provider_sign_in"],
            failed: ["I couldn't use {{provider}}. {{reason}}"],
            typing: "disabled",
        },
        guide: "Guide {{provider}}.",
        tools: ["save_profile", "show_ui"],
    };
    change(value);
    return value;
}

describe("checking an onboarding recipe against its runtime", () => {
    it("accepts a recipe that names only what the runtime offers", () => {
        expect(checkOnboardingRecipe(recipe(), OFFER)).toEqual([]);
    });

    it("accepts a recipe with no opening, which hands over to the model at once", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    delete value["bootstrap"];
                }),
                OFFER,
            ),
        ).toEqual([]);
    });

    it("refuses one that does not match the schema, at the place it fails", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].typing = "sometimes";
                }),
                OFFER,
            ),
        ).toEqual([expect.stringContaining("/bootstrap/typing")]);
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps = {};
                }),
                OFFER,
            ),
        ).toHaveLength(1);
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["figures"] = [];
                }),
                OFFER,
            ),
        ).toHaveLength(1);
    });

    it("refuses components, variables, tools, and requirements the runtime does not offer", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].say = "Hi {{name}}.";
                    value["bootstrap"].failed = "Sorry {{account}}.";
                    value["bootstrap"].offer = ["provider_sign_in", "phone_pair"];
                    value["guide"] = "Use {{secret}}.";
                    value["tools"] = ["save_profile", "delete_everything"];
                    value["requirements"] = ["provider", "payment"];
                }),
                OFFER,
            ),
        ).toEqual([
            'The opening uses an unknown variable "{{name}}".',
            'The failure text uses an unknown variable "{{account}}".',
            `The opening offers a component this runtime can't fill: "phone_pair".`,
            'The guide uses an unknown variable "{{secret}}".',
            'The recipe uses an unknown tool "delete_everything".',
            'The recipe requires something unknown: "payment".',
        ]);
    });

    it("throws with every problem when asked for a recipe that cannot run", () => {
        expect(() =>
            assertOnboardingRecipe(
                recipe((value) => {
                    value["tools"] = ["one", "two"];
                }),
                OFFER,
            ),
        ).toThrow(/unknown tool "one"[\s\S]*unknown tool "two"/u);
    });
});

describe("filling a recipe text", () => {
    it("escapes variables so no value can open a tag, an attribute, or an entity", () => {
        expect(fillRecipeText("Connect {{provider}}.", { provider: `x" onclick="y' & <b>` })).toBe(
            "Connect x&quot; onclick=&quot;y&#39; &amp; &lt;b&gt;.",
        );
    });

    it("joins lines, and leaves an unset variable empty", () => {
        expect(fillRecipeText(["Choose:", "for {{provider}}."], {})).toBe("Choose:\nfor .");
    });

    it("never reads an inherited property as a value", () => {
        expect(fillRecipeText("{{toString}}{{constructor}}", {})).toBe("");
    });
});
