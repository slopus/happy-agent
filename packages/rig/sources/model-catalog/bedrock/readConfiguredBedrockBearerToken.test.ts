import { describe, expect, it } from "vitest";

import { readConfiguredBedrockBearerToken } from "./readConfiguredBedrockBearerToken.js";

const bedrock = { enabled: true, type: "bedrock" } as const;

describe("readConfiguredBedrockBearerToken", () => {
    it("reads the default environment variable when the file says nothing", () => {
        expect(
            readConfiguredBedrockBearerToken(bedrock, { AWS_BEARER_TOKEN_BEDROCK: "env-token" }),
        ).toBe("env-token");
    });

    it("reads the environment variable the file names", () => {
        expect(
            readConfiguredBedrockBearerToken(
                { ...bedrock, bearerTokenEnvVar: "WORK_BEDROCK_TOKEN" },
                { AWS_BEARER_TOKEN_BEDROCK: "default-token", WORK_BEDROCK_TOKEN: "work-token" },
            ),
        ).toBe("work-token");
    });

    it("prefers the token written in the file over either environment variable", () => {
        expect(
            readConfiguredBedrockBearerToken(
                {
                    ...bedrock,
                    bearerToken: "file-token",
                    bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                },
                { AWS_BEARER_TOKEN_BEDROCK: "default-token", WORK_BEDROCK_TOKEN: "work-token" },
            ),
        ).toBe("file-token");
    });

    it("authenticates from the file alone, with nothing in the environment", () => {
        expect(
            readConfiguredBedrockBearerToken({ ...bedrock, bearerToken: "file-token" }, {}),
        ).toBe("file-token");
    });

    // A key left blank is not a credential, so it must not shadow a working environment variable.
    it("falls back to the environment when the configured token is blank", () => {
        expect(
            readConfiguredBedrockBearerToken(
                { ...bedrock, bearerToken: "   " },
                { AWS_BEARER_TOKEN_BEDROCK: "env-token" },
            ),
        ).toBe("env-token");
    });

    it("reports no credential when neither the file nor the environment has one", () => {
        expect(readConfiguredBedrockBearerToken(bedrock, {})).toBeUndefined();
    });

    it("reports no credential when the named variable is not set", () => {
        expect(
            readConfiguredBedrockBearerToken(
                { ...bedrock, bearerTokenEnvVar: "MISSING_TOKEN" },
                { AWS_BEARER_TOKEN_BEDROCK: "default-token" },
            ),
        ).toBeUndefined();
    });
});
