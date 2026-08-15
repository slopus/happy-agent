import * as root from "../../sources/index.js";
import {
    systemPromptFeatureOptionsSchema,
    systemPromptIdentitySchema,
    systemPromptSelectionSchema,
} from "../../sources/systemPrompt/SystemPromptFeature.js";
import { systemPromptProviderKindSchema } from "../../sources/systemPrompt/SystemPromptSelection.js";
import { describe, expect, it } from "vitest";

describe("System Prompt package exports", () => {
    it("exposes the same runtime contracts from the package root", () => {
        expect(root.systemPromptFeatureOptionsSchema).toBe(systemPromptFeatureOptionsSchema);
        expect(root.systemPromptIdentitySchema).toBe(systemPromptIdentitySchema);
        expect(root.systemPromptSelectionSchema).toBe(systemPromptSelectionSchema);
        expect(root.systemPromptProviderKindSchema).toBe(systemPromptProviderKindSchema);
        expect(root.SystemPromptFeature).toBeDefined();
        expect(root.systemPromptForModel).toBeDefined();
    });
});
