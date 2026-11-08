// Writes the onboarding recipe JSON Schema from its TypeBox source, for recipes written outside
// this package. tests/onboarding/onboardingRecipeSchemaFile.test.ts fails while the file is stale.
// Run from packages/happy-agent-modules: node --import tsx scripts/write-onboarding-recipe-schema.ts
import { writeFile } from "node:fs/promises";

import { onboardingRecipeJsonSchema } from "../sources/onboarding/impl/onboardingRecipeJsonSchema.js";

const path = new URL("../sources/onboarding/recipes/onboardingRecipe.schema.json", import.meta.url);
await writeFile(path, `${JSON.stringify(onboardingRecipeJsonSchema(), null, 4)}\n`);
