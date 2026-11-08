import { describe, expect, it } from "vitest";

import { typedAnswer } from "../../sources/onboarding/impl/typedAnswer.js";
import type { OnboardingRecipeStep } from "../../sources/onboarding/index.js";

const NAMING: OnboardingRecipeStep = {
    say: [{ text: "What should the team call me?" }],
    next: { rename: { params: { name: {} } }, pick: { params: { size: { values: ["S", "M"] } } } },
    input: { step: "rename", param: "name", maxLength: 12 },
};

describe("a typed answer to a scripted step", () => {
    it("fills the step's parameter with the trimmed text", () => {
        expect(typedAnswer(NAMING, "  Juno \n")).toEqual({
            step: "rename",
            params: { name: "Juno" },
        });
        // Twelve characters, counted as code points rather than UTF-16 units.
        expect(typedAnswer(NAMING, "Ñandú 🦤🦤🦤🦤🦤🦤")?.params).toEqual({
            name: "Ñandú 🦤🦤🦤🦤🦤🦤",
        });
    });

    it("leaves anything that does not fit to the recipe's typing rule", () => {
        for (const text of [
            "",
            "   ",
            "Juno\nAtlas",
            "A name far too long",
            "Ñandú 🦤🦤🦤🦤🦤🦤🦤",
        ]) {
            expect(typedAnswer(NAMING, text), JSON.stringify(text)).toBeUndefined();
        }
        expect(typedAnswer({ say: NAMING.say!, next: NAMING.next! }, "Juno")).toBeUndefined();
        expect(typedAnswer(undefined, "Juno")).toBeUndefined();
    });

    it("takes only a listed value when the parameter lists them", () => {
        const sizing: OnboardingRecipeStep = {
            ...NAMING,
            input: { step: "pick", param: "size" },
        };
        expect(typedAnswer(sizing, "M")).toEqual({ step: "pick", params: { size: "M" } });
        expect(typedAnswer(sizing, "XL")).toBeUndefined();
    });
});
