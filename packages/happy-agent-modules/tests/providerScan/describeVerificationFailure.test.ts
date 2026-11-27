import { describe, expect, it } from "vitest";

import {
    describeVerificationFailure,
    isModelSpecificFailure,
    type VerificationProblem,
    type VerificationTarget,
} from "../../sources/providerScan/describeVerificationFailure.js";

const BEDROCK: VerificationTarget = {
    awsProfile: "corp-sso",
    label: "Amazon Bedrock",
    modelId: "anthropic/fable-5",
    region: "us-east-1",
    type: "bedrock",
};

const GATEWAY: VerificationTarget = {
    host: "llm.corp.example",
    label: "llm.corp.example",
    modelId: "gateway/model",
    type: "openai_compatible",
};

describe("describeVerificationFailure", () => {
    it("explains missing AWS credentials with the profile's sign-in command", () => {
        expect(
            describeVerificationFailure(BEDROCK, { type: "credentials", status: "missing" }),
        ).toEqual({
            kind: "credentials_missing",
            message:
                "No AWS credentials found for profile `corp-sso`. Run `aws sso login --profile corp-sso` or add credentials for that profile, then try again.",
        });
    });

    it("names an unset API key variable without reading it", () => {
        expect(
            describeVerificationFailure(
                { ...GATEWAY, credentialEnvVar: "CORP_LLM_KEY" },
                { type: "credentials", status: "missing" },
            ),
        ).toEqual({
            kind: "credentials_missing",
            message:
                "The environment variable `CORP_LLM_KEY` that holds the API key for llm.corp.example is not set for Happy. Set it where Happy starts, or set `api_key` for this provider.",
        });
    });

    it("reports an expired AWS SSO session as an authentication failure", () => {
        const error = Object.assign(
            new Error(
                "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
            ),
            { name: "CredentialsProviderError" },
        );
        const failure = describeVerificationFailure(BEDROCK, { type: "thrown", error });
        expect(failure.kind).toBe("credentials_missing");

        const expired = describeVerificationFailure(BEDROCK, {
            type: "session_error",
            kind: "unknown",
            message: "The security token included in the request is expired",
            providerError: {
                type: "authentication",
                diagnostics: { errorType: "ExpiredTokenException", status: 403 },
            },
        });
        expect(expired.kind).toBe("authentication");
        expect(expired.message).toContain("has expired");
        expect(expired.message).toContain("aws sso login --profile corp-sso");
    });

    it("explains an untrusted certificate from a TLS-inspecting proxy", () => {
        const error = new TypeError("fetch failed", {
            cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
                code: "SELF_SIGNED_CERT_IN_CHAIN",
            }),
        });
        expect(describeVerificationFailure(GATEWAY, { type: "thrown", error })).toEqual({
            kind: "tls",
            message:
                "The TLS certificate of llm.corp.example is not trusted (self-signed certificate in chain). If your network uses a TLS-inspecting proxy, set NODE_EXTRA_CA_CERTS to your organization's CA bundle for Happy and restart it.",
        });
    });

    it("finds a TLS code carried by provider diagnostics", () => {
        const failure = describeVerificationFailure(BEDROCK, {
            type: "session_error",
            kind: "unknown",
            message: "The network connection to Anthropic Bedrock was lost.",
            providerError: {
                type: "network",
                diagnostics: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
            },
        });
        expect(failure.kind).toBe("tls");
        expect(failure.message).toContain("unable to get local issuer certificate");
    });

    it("names the unreachable host and the network reason", () => {
        const error = new TypeError("fetch failed", {
            cause: Object.assign(new Error("getaddrinfo ENOTFOUND llm.corp.example"), {
                code: "ENOTFOUND",
                hostname: "llm.corp.example",
            }),
        });
        const failure = describeVerificationFailure(GATEWAY, { type: "thrown", error });
        expect(failure.kind).toBe("network");
        expect(failure.message).toMatch(
            /^Couldn't connect to llm\.corp\.example \(host not found\)\. Check your network, VPN, or proxy settings \(HTTPS_PROXY\) for Happy\./u,
        );
    });

    it("reports the overall time bound", () => {
        expect(describeVerificationFailure(BEDROCK, { type: "timeout", seconds: 30 })).toEqual({
            kind: "timeout",
            message:
                "Amazon Bedrock did not answer within 30 seconds in us-east-1. Check your network, VPN, or proxy, then try again.",
        });
    });

    it("recognizes a model the account or region cannot use", () => {
        const failure = describeVerificationFailure(BEDROCK, {
            type: "session_error",
            kind: "unknown",
            message: "You don't have access to the model with the specified model ID.",
            providerError: {
                type: "authentication",
                diagnostics: { errorType: "AccessDeniedException", status: 403 },
            },
        });
        expect(failure.kind).toBe("model_unavailable");
        expect(failure.message).toContain("Model anthropic/fable-5 is not available");
        expect(failure.message).toContain("in us-east-1");
        expect(failure.message).toContain(
            "Details: You don't have access to the model with the specified model ID.",
        );
    });

    it.each([
        [{ type: "authentication" as const, diagnostics: { status: 401 } }, "authentication"],
        [{ type: "rate_limit" as const }, "quota"],
        [{ type: "out_of_tokens" as const }, "quota"],
        [{ type: "server_overloaded" as const, diagnostics: { status: 529 } }, "provider_error"],
        [{ type: "empty_response" as const }, "provider_error"],
        [{ type: "network" as const }, "network"],
        [{ type: "unclassified" as const, diagnostics: { status: 404 } }, "unknown"],
        [
            {
                type: "unclassified" as const,
                diagnostics: { code: "model_not_found", status: 404 },
            },
            "model_unavailable",
        ],
        [{ type: "unclassified" as const, diagnostics: { status: 418 } }, "unknown"],
    ])("classifies provider error %j as %s", (providerError, kind) => {
        expect(
            describeVerificationFailure(GATEWAY, {
                type: "session_error",
                kind: "unknown",
                message: "The request failed.",
                providerError,
            }).kind,
        ).toBe(kind);
    });

    it("treats a 404 as a model problem only when the vendor names the model", () => {
        const bare: VerificationProblem = {
            type: "session_error",
            kind: "unknown",
            message: "Not Found",
            providerError: { type: "unclassified", diagnostics: { status: 404 } },
        };
        expect(isModelSpecificFailure(GATEWAY, bare)).toBe(false);
        expect(describeVerificationFailure(GATEWAY, bare)).toEqual({
            kind: "unknown",
            message:
                "llm.corp.example answered the test request with HTTP 404 (not found), so the endpoint address is probably wrong. Check the base URL configured for this provider. Details: Not Found",
        });
        expect(
            describeVerificationFailure({ ...GATEWAY, label: "Corp Gateway" }, bare).message,
        ).toMatch(/^Corp Gateway answered the test request at llm\.corp\.example with HTTP 404/u);

        const named: VerificationProblem = {
            type: "session_error",
            kind: "unknown",
            message: "model: claude-sonnet-9",
            providerError: {
                type: "unclassified",
                diagnostics: { errorType: "not_found_error", status: 404 },
            },
        };
        expect(isModelSpecificFailure(GATEWAY, named)).toBe(true);
        expect(describeVerificationFailure(GATEWAY, named).kind).toBe("model_unavailable");
    });

    it("classifies the remaining verification problems", () => {
        expect(describeVerificationFailure(GATEWAY, { type: "no_model" }).kind).toBe("no_model");
        expect(describeVerificationFailure(GATEWAY, { type: "unprepared" }).kind).toBe(
            "credentials_missing",
        );
        expect(
            describeVerificationFailure(GATEWAY, { type: "credentials", status: "error" }).kind,
        ).toBe("unknown");
        expect(describeVerificationFailure(GATEWAY, { type: "aborted" }).kind).toBe("unknown");
        expect(describeVerificationFailure(GATEWAY, { type: "incomplete", state: null }).kind).toBe(
            "provider_error",
        );
        expect(
            describeVerificationFailure(GATEWAY, {
                type: "account_check",
                error: Object.assign(new Error("Usage request failed."), { status: 401 }),
            }).kind,
        ).toBe("authentication");
    });

    it("never returns credentials from a vendor message and caps the length", () => {
        const failure = describeVerificationFailure(GATEWAY, {
            type: "session_error",
            kind: "unknown",
            message: `Incorrect API key provided: sk-proj-abcdefghijklmnop. Sent Authorization: Bearer tok_123456 to https://llm.corp.example/v1?key=s3cret ${"x ".repeat(400)}`,
            providerError: { type: "authentication", diagnostics: { status: 401 } },
        });
        expect(failure.kind).toBe("authentication");
        expect(failure.message).not.toMatch(/sk-proj|tok_123456|s3cret/u);
        expect(failure.message.length).toBeLessThanOrEqual(500);
    });

    it("explains a provider that offers only Fable models", () => {
        expect(describeVerificationFailure(BEDROCK, { type: "no_model", onlyFable: true })).toEqual(
            {
                kind: "no_model",
                message:
                    "Happy doesn't test with Fable models. Enable another model for Amazon Bedrock (for example Sonnet) so Happy can check it.",
            },
        );
    });

    it("lists the models tried before a failure every model would share", () => {
        const failure = describeVerificationFailure(
            {
                ...BEDROCK,
                modelId: "anthropic/opus-5",
                triedModelIds: ["anthropic/sonnet-5", "anthropic/opus-5"],
            },
            {
                type: "session_error",
                kind: "unknown",
                message: "Too many requests.",
                providerError: { type: "rate_limit", diagnostics: { status: 429 } },
            },
        );
        expect(failure.kind).toBe("quota");
        expect(failure.message).toMatch(
            /^Tried anthropic\/sonnet-5, anthropic\/opus-5\. Amazon Bedrock refused the test request/u,
        );
    });

    it("says the credentials work when every tried model failed on its own", () => {
        const failure = describeVerificationFailure(
            {
                ...BEDROCK,
                modelId: "anthropic/opus-5",
                triedModelIds: ["anthropic/sonnet-5", "anthropic/opus-5"],
            },
            {
                type: "models_failed",
                attempts: [
                    {
                        modelName: "Sonnet 5",
                        problem: {
                            type: "session_error",
                            kind: "unknown",
                            message: "The provided model identifier is invalid.",
                            providerError: { type: "unclassified", diagnostics: { status: 400 } },
                        },
                    },
                    {
                        modelName: "Opus 5 1M",
                        problem: {
                            type: "session_error",
                            kind: "unknown",
                            message: '"thinking.type.disabled" is not supported for this model',
                            providerError: { type: "unclassified", diagnostics: { status: 400 } },
                        },
                    },
                ],
            },
        );
        expect(failure).toEqual({
            kind: "model_unavailable",
            message:
                "Your credentials for Amazon Bedrock work, but none of the models Happy tried answered: Sonnet 5 (not available in us-east-1), Opus 5 1M (request rejected for this model). Enable a model your account can use under Model access in the Amazon Bedrock console.",
        });
    });

    it.each<[string, VerificationProblem]>([
        [
            "an unknown model",
            {
                type: "session_error",
                kind: "unknown",
                message: "model 'anthropic.claude-fable-5' does not exist",
                providerError: { type: "unclassified", diagnostics: { status: 400 } },
            },
        ],
        [
            "no access to the model",
            {
                type: "session_error",
                kind: "unknown",
                message: "You don't have access to the model with the specified model ID.",
                providerError: {
                    type: "authentication",
                    diagnostics: { errorType: "AccessDeniedException", status: 403 },
                },
            },
        ],
        [
            "a thinking setting the model rejects",
            {
                type: "session_error",
                kind: "unknown",
                message: '"thinking.type.disabled" is not supported for this model',
                providerError: {
                    type: "unclassified",
                    diagnostics: { errorType: "ValidationException", status: 400 },
                },
            },
        ],
        [
            "an invalid request thrown by the SDK",
            {
                type: "thrown",
                error: Object.assign(new Error("Unsupported parameter: reasoning.effort"), {
                    status: 400,
                }),
            },
        ],
    ])("moves on to another model after %s", (_name, problem) => {
        expect(isModelSpecificFailure(BEDROCK, problem)).toBe(true);
    });

    it.each<[string, VerificationProblem]>([
        ["missing credentials", { type: "credentials", status: "missing" }],
        ["an unprepared provider", { type: "unprepared" }],
        ["a timeout", { type: "timeout", seconds: 30 }],
        [
            "rejected credentials",
            {
                type: "session_error",
                kind: "unknown",
                message: "Invalid API key.",
                providerError: { type: "authentication", diagnostics: { status: 401 } },
            },
        ],
        [
            "missing AWS credentials",
            {
                type: "thrown",
                error: Object.assign(new Error("Could not load credentials from any providers"), {
                    name: "CredentialsProviderError",
                }),
            },
        ],
        [
            "an untrusted certificate",
            {
                type: "thrown",
                error: new TypeError("fetch failed", {
                    cause: Object.assign(
                        new Error("self-signed certificate in certificate chain"),
                        {
                            code: "SELF_SIGNED_CERT_IN_CHAIN",
                        },
                    ),
                }),
            },
        ],
        [
            "an unreachable host",
            {
                type: "thrown",
                error: new TypeError("fetch failed", {
                    cause: Object.assign(new Error("connect ECONNREFUSED"), {
                        code: "ECONNREFUSED",
                    }),
                }),
            },
        ],
        [
            "a quota",
            {
                type: "session_error",
                kind: "unknown",
                message: "Too many requests.",
                providerError: { type: "rate_limit", diagnostics: { status: 429 } },
            },
        ],
        [
            "a provider outage",
            {
                type: "session_error",
                kind: "unknown",
                message: "Internal server error.",
                providerError: { type: "internal_server_error", diagnostics: { status: 500 } },
            },
        ],
    ])("stops after %s", (_name, problem) => {
        expect(isModelSpecificFailure(BEDROCK, problem)).toBe(false);
    });
});
