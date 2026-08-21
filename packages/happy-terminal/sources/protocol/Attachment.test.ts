import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { AttachmentSchema } from "./Attachment.js";

describe("AttachmentSchema", () => {
    it("accepts a secret request without carrying secret values", () => {
        expect(
            Value.Check(AttachmentSchema, {
                description: "Credentials used to publish releases.",
                environmentVariables: ["NPM_TOKEN", "NPM_CONFIG_REGISTRY"],
                id: "attachment-1",
                instructions: "Create an npm access token with permission to publish this package.",
                kind: "secret_request",
                operation: "create",
                secretId: "npm-publishing",
            }),
        ).toBe(true);
    });

    it.each([
        ["a secret value", { environment: { NPM_TOKEN: "do-not-store-here" } }],
        ["an invalid operation", { operation: "replace" }],
        ["an invalid secret id", { secretId: "npm publishing" }],
        ["an invalid variable name", { environmentVariables: ["NPM-TOKEN"] }],
        ["duplicate variable names", { environmentVariables: ["NPM_TOKEN", "NPM_TOKEN"] }],
    ])("rejects a secret request with %s", (_label, change) => {
        expect(
            Value.Check(AttachmentSchema, {
                description: "Credentials used to publish releases.",
                environmentVariables: ["NPM_TOKEN"],
                id: "attachment-1",
                instructions: "Create an npm access token.",
                kind: "secret_request",
                operation: "create",
                secretId: "npm-publishing",
                ...change,
            }),
        ).toBe(false);
    });
});
