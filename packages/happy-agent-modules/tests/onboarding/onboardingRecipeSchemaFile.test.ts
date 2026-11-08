import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { onboardingRecipeJsonSchema } from "../../sources/onboarding/impl/onboardingRecipeJsonSchema.js";

describe("the onboarding recipe JSON Schema file", () => {
    it("is generated from the recipe's TypeBox schema", async () => {
        const file: unknown = JSON.parse(
            await readFile(
                new URL(
                    "../../sources/onboarding/recipes/onboardingRecipe.schema.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        );
        // Stale: run `node --import tsx scripts/write-onboarding-recipe-schema.ts` in this package.
        expect(file).toEqual(onboardingRecipeJsonSchema());
    });
});
