import type {
    ProviderVerificationFailure,
    ProviderVerificationFailureKind,
} from "@slopus/happy-agent-client";
import type { SessionErrorKind, SessionProviderError } from "@slopus/happy-providers";

import { sanitizeVerificationDiagnostic, truncate } from "./sanitizeVerificationDiagnostic.js";

const MESSAGE_LIMIT = 500;

/** Non-secret facts about the verified provider that make a failure message actionable. */
export interface VerificationTarget {
    /** The provider registry type, such as `bedrock` or `openai_compatible`. */
    readonly type: string | null;
    /** The person's name for the provider, or a readable name for its type. */
    readonly label: string;
    /** The configured endpoint host, never a full URL. */
    readonly host?: string;
    readonly region?: string;
    readonly awsProfile?: string;
    /** The name, never the value, of the environment variable expected to hold the credential. */
    readonly credentialEnvVar?: string;
    readonly modelId: string | null;
    /** Every model a failed inference check tried, cheapest first; the last is `modelId`. */
    readonly triedModelIds?: readonly string[];
}

/** What went wrong during one verification, before it is explained to the person. */
export type VerificationProblem =
    | { readonly type: "credentials"; readonly status: "missing" | "error" }
    | { readonly type: "no_model"; readonly onlyFable?: boolean }
    | { readonly type: "unprepared" }
    | { readonly type: "timeout"; readonly seconds: number }
    | { readonly type: "aborted" }
    | { readonly type: "account_check"; readonly error: unknown }
    | { readonly type: "thrown"; readonly error: unknown }
    | {
          readonly type: "session_error";
          readonly kind: SessionErrorKind;
          readonly message: string;
          readonly providerError?: SessionProviderError;
      }
    | { readonly type: "incomplete"; readonly state: string | null }
    | {
          /** Every model tried failed for a reason of its own, so the credentials do work. */
          readonly type: "models_failed";
          readonly attempts: readonly {
              readonly modelName: string;
              readonly problem: VerificationProblem;
          }[];
      };

/** Classify a verification problem and explain it without credentials or raw vendor output. */
export function describeVerificationFailure(
    target: VerificationTarget,
    problem: VerificationProblem,
): ProviderVerificationFailure {
    const failure = explain(target, problem);
    const tried = target.triedModelIds ?? [];
    const message =
        tried.length > 1 && problem.type !== "models_failed"
            ? `Tried ${tried.join(", ")}. ${failure.message}`
            : failure.message;
    return { kind: failure.kind, message: truncate(message, MESSAGE_LIMIT) };
}

/**
 * Whether another model might pass where this one failed: the model is unavailable or not
 * allowed, or the request was invalid for this model (such as a thinking setting it rejects).
 * Missing credentials, sign-in, TLS, network, quota, and provider-side failures would fail for
 * every model, so they are not model-specific.
 */
export function isModelSpecificFailure(
    target: VerificationTarget,
    problem: VerificationProblem,
): boolean {
    if (problem.type !== "session_error" && problem.type !== "thrown") return false;
    const evidence =
        problem.type === "session_error" ? sessionEvidence(problem) : errorEvidence(problem.error);
    const { kind } = classify(target, evidence);
    return kind === "model_unavailable" || (kind === "unknown" && invalidRequest(evidence));
}

/** The daemon-log reason for a problem, kept in the wording support already searches for. */
export function verificationProblemReason(problem: VerificationProblem): string {
    switch (problem.type) {
        case "credentials":
            return `Local credential discovery reported "${problem.status}".`;
        case "no_model":
            return problem.onlyFable === true
                ? "The provider offers only Fable models, which are never used for verification."
                : "The provider offers no model to check inference with.";
        case "unprepared":
            return "The provider could not be prepared for inference.";
        case "timeout":
            return "Provider verification timed out.";
        case "aborted":
            return "Provider verification was cancelled.";
        case "account_check":
            return `The account check failed: ${describeError(problem.error)}`;
        case "thrown":
            return describeError(problem.error);
        case "session_error":
            return `The model request failed: ${problem.message}`;
        case "incomplete":
            return problem.state === null
                ? "The model stream ended without a final result."
                : `The model request ended in the "${problem.state}" state.`;
        case "models_failed":
            return `No tried model answered. ${problem.attempts
                .map(
                    ({ modelName, problem }) =>
                        `${modelName}: ${verificationProblemReason(problem)}`,
                )
                .join(" ")}`;
    }
}

interface Evidence {
    readonly providerErrorType?: SessionProviderError["type"] | undefined;
    readonly sessionKind?: SessionErrorKind | undefined;
    readonly status?: number | undefined;
    readonly codes: readonly string[];
    readonly names: readonly string[];
    readonly hostname?: string | undefined;
    readonly text: string;
}

type Explained = { readonly kind: ProviderVerificationFailureKind; readonly message: string };

function explain(target: VerificationTarget, problem: VerificationProblem): Explained {
    switch (problem.type) {
        case "credentials":
            return problem.status === "missing"
                ? missingCredentials(target)
                : {
                      kind: "unknown",
                      message: `Couldn't check the local credentials for ${target.label}. Try again, and restart Happy if it keeps failing.`,
                  };
        case "unprepared":
            return missingCredentials(target);
        case "no_model":
            if (problem.onlyFable === true) {
                return {
                    kind: "no_model",
                    message: `Happy doesn't test with Fable models. Enable another model for ${target.label} (for example Sonnet) so Happy can check it.`,
                };
            }
            return {
                kind: "no_model",
                message: `${target.label} offers no model to verify with. Check the provider's model list and its include or exclude filters.`,
            };
        case "timeout":
            return {
                kind: "timeout",
                message: `${target.label} did not answer within ${problem.seconds} seconds${at(target)}. Check your network, VPN, or proxy, then try again.`,
            };
        case "aborted":
            return {
                kind: "unknown",
                message: `Verifying ${target.label} was cancelled because the provider was disabled or the request ended.`,
            };
        case "incomplete":
            if (problem.state === "cancelled") return explain(target, { type: "aborted" });
            return {
                kind: "provider_error",
                message: `${target.label} ended the test request${model(target)} without a reply. Try again in a few minutes.`,
            };
        case "account_check":
        case "thrown":
            return classify(target, errorEvidence(problem.error));
        case "session_error":
            return classify(target, sessionEvidence(problem));
        case "models_failed":
            return modelsFailed(target, problem.attempts);
    }
}

function modelsFailed(
    target: VerificationTarget,
    attempts: Extract<VerificationProblem, { type: "models_failed" }>["attempts"],
): Explained {
    const tried = attempts.map(({ modelName, problem }) => {
        const unavailable = explain(target, problem).kind === "model_unavailable";
        const reason = unavailable
            ? `not available${target.region === undefined ? "" : ` in ${target.region}`}`
            : "request rejected for this model";
        return `${truncate(modelName.replace(/\s+/gu, " ").trim(), 64)} (${reason})`;
    });
    return {
        kind: "model_unavailable",
        message: `Your credentials for ${target.label} work, but none of the models Happy tried answered: ${tried.join(", ")}. Enable a model your account can use${target.type === "bedrock" ? " under Model access in the Amazon Bedrock console" : ""}.`,
    };
}

function classify(target: VerificationTarget, evidence: Evidence): Explained {
    const details = diagnostic(evidence.text);
    const text = evidence.text.toLowerCase();
    const has = (...codes: string[]) => codes.some((code) => evidence.codes.includes(code));
    const named = (...names: string[]) => names.some((name) => evidence.names.includes(name));
    const host = evidence.hostname ?? target.host;

    const tls = tlsReason(evidence.codes, text);
    if (tls !== undefined) {
        return {
            kind: "tls",
            message: `The TLS certificate ${host === undefined ? `for ${target.label}` : `of ${host}`} is not trusted (${tls}). If your network uses a TLS-inspecting proxy, set NODE_EXTRA_CA_CERTS to your organization's CA bundle for Happy and restart it.`,
        };
    }

    if (
        named("CredentialsProviderError", "ProviderCredentialsUnavailableError") ||
        /could not load credentials|unable to locate credentials|no credentials|credentials? (?:are|is) missing/u.test(
            text,
        )
    ) {
        return missingCredentials(target, details);
    }
    if (
        named("ExpiredTokenException", "ExpiredToken", "TokenRefreshRequired") ||
        /sso session .*expired|token (?:is|has) expired|security token included in the request is expired|refresh (?:the )?sso/u.test(
            text,
        )
    ) {
        return {
            kind: "authentication",
            message: `The sign-in for ${target.label}${awsProfile(target)} has expired.${signInAgain(target)}${suffix(details)}`,
        };
    }

    // A 404 is about the model only when the vendor says so. A bare 404 is what any server answers
    // on a path it does not serve, before it reads a key, so it proves nothing about the model or
    // the credentials.
    if (
        (evidence.status === 404 && (has("model_not_found") || /\bmodel\b/u.test(text))) ||
        named("ResourceNotFoundException") ||
        /model.{0,80}(?:not found|does not exist|not available|not supported|isn't supported|is not enabled|invalid)|(?:access|permission).{0,40}\bmodel\b|model identifier is invalid|unknown model|no such model|on-demand throughput/u.test(
            text,
        )
    ) {
        return {
            kind: "model_unavailable",
            message: `Model ${target.modelId ?? "used for verification"} is not available to this ${target.type === "bedrock" ? "AWS account" : "account"}${target.region === undefined ? "" : ` in ${target.region}`}. ${target.type === "bedrock" ? "Request access to it under Model access in the Amazon Bedrock console, or choose another region." : "Check the model ID and endpoint, or allow the model for this account."}${suffix(details)}`,
        };
    }
    if (evidence.status === 404) {
        // An unnamed endpoint is already called by its host.
        const where = target.label === target.host ? "" : at(target);
        return {
            kind: "unknown",
            message: `${target.label} answered the test request${where} with HTTP 404 (not found), so the endpoint address is probably wrong. Check the base URL configured for this provider.${suffix(details)}`,
        };
    }

    if (
        evidence.providerErrorType === "authentication" ||
        evidence.status === 401 ||
        evidence.status === 403 ||
        named(
            "UnrecognizedClientException",
            "AccessDeniedException",
            "InvalidSignatureException",
            "InvalidClientTokenId",
            "AuthenticationError",
        ) ||
        /unauthori[sz]ed|invalid (?:api|x-api|access) key|incorrect api key|invalid authentication|authentication failed|forbidden/u.test(
            text,
        )
    ) {
        return {
            kind: "authentication",
            message: `${target.label} rejected the credentials${awsProfile(target)}.${signInAgain(target)}${suffix(details)}`,
        };
    }

    if (
        evidence.providerErrorType === "rate_limit" ||
        evidence.providerErrorType === "out_of_tokens" ||
        evidence.sessionKind === "billing_error" ||
        evidence.status === 402 ||
        evidence.status === 429 ||
        named("ThrottlingException", "ServiceQuotaExceededException") ||
        /rate limit|quota|too many requests|insufficient (?:credit|funds|balance)|credit balance|billing|payment required|usage credits/u.test(
            text,
        )
    ) {
        return {
            kind: "quota",
            message: `${target.label} refused the test request because of a rate limit, quota, or billing problem. Check the account's plan, credits, and limits, then try again.${suffix(details)}`,
        };
    }

    const network = networkReason(evidence.codes, text);
    if (evidence.providerErrorType === "network" || network !== undefined) {
        const proxy = /proxy/u.test(text) || has("ERR_PROXY_CONNECTION_FAILED");
        return {
            kind: "network",
            message: `Couldn't connect to ${host ?? target.label}${network === undefined ? "" : ` (${network})`}. ${proxy ? "Check the proxy settings Happy uses (HTTPS_PROXY)." : "Check your network, VPN, or proxy settings (HTTPS_PROXY) for Happy."}${suffix(details)}`,
        };
    }

    if (
        evidence.providerErrorType === "server_overloaded" ||
        evidence.providerErrorType === "internal_server_error" ||
        evidence.providerErrorType === "empty_response" ||
        evidence.sessionKind === "internal_error" ||
        (evidence.status !== undefined && evidence.status >= 500)
    ) {
        return {
            kind: "provider_error",
            message: `${target.label} had a problem on its side${evidence.status === undefined ? "" : ` (HTTP ${evidence.status})`}. Try again in a few minutes.${suffix(details)}`,
        };
    }

    return {
        kind: "unknown",
        message: `${target.label} failed the test request${model(target)}${evidence.status === undefined ? "" : ` (HTTP ${evidence.status})`}.${suffix(details)}`,
    };
}

function invalidRequest(evidence: Evidence): boolean {
    return (
        evidence.status === 400 ||
        evidence.status === 422 ||
        evidence.names.some((name) =>
            ["ValidationException", "BadRequestError", "invalid_request_error"].includes(name),
        ) ||
        /not supported|unsupported|invalid[_ ]request|validation ?exception/u.test(
            evidence.text.toLowerCase(),
        )
    );
}

function missingCredentials(target: VerificationTarget, details?: string): Explained {
    const env = target.credentialEnvVar === undefined ? undefined : quote(target.credentialEnvVar);
    let message: string;
    switch (target.type) {
        case "bedrock":
            message =
                target.awsProfile === undefined
                    ? `No AWS credentials found for ${target.label}. Sign in with the AWS CLI (for example \`aws sso login\`) or configure an AWS profile, then try again.`
                    : `No AWS credentials found for profile ${quote(target.awsProfile)}. Run \`aws sso login --profile ${plain(target.awsProfile)}\` or add credentials for that profile, then try again.`;
            if (env !== undefined) {
                message += ` If you use a Bedrock API key, make sure ${env} is set where Happy starts.`;
            }
            break;
        case "openai_compatible":
            message =
                env === undefined
                    ? `No API key is configured for ${target.host ?? target.label}. Set \`api_key\` or \`api_key_env\` for this provider.`
                    : `The environment variable ${env} that holds the API key for ${target.host ?? target.label} is not set for Happy. Set it where Happy starts, or set \`api_key\` for this provider.`;
            break;
        case "claude":
            message = `No Claude sign-in found. Sign in with Claude Code, then try again.`;
            break;
        case "codex":
            message = "No Codex sign-in found. Run `codex login`, then try again.";
            break;
        case "grok":
            message = "No Grok sign-in found. Sign in with the Grok CLI, then try again.";
            break;
        default:
            message = `No credentials found for ${target.label}. Sign in to it, then try again.`;
    }
    return { kind: "credentials_missing", message: `${message}${suffix(details)}` };
}

function signInAgain(target: VerificationTarget): string {
    switch (target.type) {
        case "bedrock":
            return target.awsProfile === undefined
                ? " If you use AWS SSO, run `aws sso login`; otherwise check the credentials and their Bedrock permissions."
                : ` If the profile uses AWS SSO, run \`aws sso login --profile ${plain(target.awsProfile)}\`; otherwise check its credentials and Bedrock permissions.`;
        case "openai_compatible":
            return " Check the API key configured for this provider.";
        case "claude":
            return " Sign in with Claude Code again.";
        case "codex":
            return " Run `codex login` again.";
        case "grok":
            return " Sign in with the Grok CLI again.";
        default:
            return " Sign in again or check the configured credentials.";
    }
}

const TLS_REASONS: Readonly<Record<string, string>> = {
    SELF_SIGNED_CERT_IN_CHAIN: "self-signed certificate in chain",
    DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate",
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "unable to get local issuer certificate",
    UNABLE_TO_GET_ISSUER_CERT: "unable to get issuer certificate",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "unable to verify the first certificate",
    CERT_HAS_EXPIRED: "certificate has expired",
    CERT_NOT_YET_VALID: "certificate is not yet valid",
    CERT_UNTRUSTED: "certificate is not trusted",
    ERR_TLS_CERT_ALTNAME_INVALID: "certificate name does not match the host",
};

function tlsReason(codes: readonly string[], text: string): string | undefined {
    for (const code of codes) {
        const reason = TLS_REASONS[code];
        if (reason !== undefined) return reason;
    }
    const match =
        /self[- ]signed certificate(?: in certificate chain)?|unable to (?:get local issuer certificate|verify the first certificate)|certificate has expired|does not match certificate|unknown certificate|certificate verify failed/u.exec(
            text,
        );
    return match?.[0];
}

const NETWORK_REASONS: Readonly<Record<string, string>> = {
    ENOTFOUND: "host not found",
    EAI_AGAIN: "DNS lookup failed",
    ECONNREFUSED: "connection refused",
    ECONNRESET: "connection reset",
    ECONNABORTED: "connection aborted",
    EPIPE: "connection closed",
    EHOSTUNREACH: "host unreachable",
    ENETUNREACH: "network unreachable",
    ENETDOWN: "network is down",
    ETIMEDOUT: "connection timed out",
    UND_ERR_CONNECT_TIMEOUT: "connection timed out",
    UND_ERR_HEADERS_TIMEOUT: "no response",
    UND_ERR_BODY_TIMEOUT: "response stalled",
    UND_ERR_SOCKET: "connection closed",
    ERR_PROXY_CONNECTION_FAILED: "proxy connection failed",
};

function networkReason(codes: readonly string[], text: string): string | undefined {
    for (const code of codes) {
        const reason = NETWORK_REASONS[code];
        if (reason !== undefined) return reason;
    }
    for (const [code, reason] of Object.entries(NETWORK_REASONS)) {
        if (text.includes(code.toLowerCase())) return reason;
    }
    if (/^fetch failed$|socket hang up|other side closed|premature close/u.test(text)) {
        return "connection failed";
    }
    return undefined;
}

function sessionEvidence(
    problem: Extract<VerificationProblem, { type: "session_error" }>,
): Evidence {
    const diagnostics = problem.providerError?.diagnostics;
    const upstream = diagnostics?.upstreamMessage;
    return {
        codes: diagnostics?.code === undefined ? [] : [diagnostics.code],
        names: diagnostics?.errorType === undefined ? [] : [diagnostics.errorType],
        providerErrorType: problem.providerError?.type,
        sessionKind: problem.kind,
        status: diagnostics?.status,
        text:
            upstream === undefined || problem.message.includes(upstream)
                ? problem.message
                : `${problem.message} ${upstream}`,
    };
}

function errorEvidence(error: unknown): Evidence {
    const codes: string[] = [];
    const names: string[] = [];
    const texts: string[] = [];
    let status: number | undefined;
    let hostname: string | undefined;
    const seen = new Set<object>();
    const pending: unknown[] = [error];
    while (pending.length > 0 && seen.size < 12) {
        const value = pending.shift();
        if (typeof value === "string") {
            texts.push(value);
            continue;
        }
        if (typeof value !== "object" || value === null || seen.has(value)) continue;
        seen.add(value);
        const record = value as Record<string, unknown>;
        if (typeof record.code === "string") codes.push(record.code);
        if (typeof record.name === "string" && record.name !== "Error") names.push(record.name);
        if (typeof record.message === "string" && record.message !== "") {
            texts.push(record.message);
        }
        status ??= httpStatus(record);
        if (hostname === undefined && typeof record.hostname === "string") {
            hostname = validHostname(record.hostname);
        }
        pending.push(record.cause, record.error);
    }
    return { codes, hostname, names, status, text: texts.join(" ") };
}

function httpStatus(record: Record<string, unknown>): number | undefined {
    const metadata = record.$metadata as { httpStatusCode?: unknown } | undefined;
    for (const value of [record.status, record.statusCode, metadata?.httpStatusCode]) {
        if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value < 600) {
            return value;
        }
    }
    return undefined;
}

function validHostname(value: string): string | undefined {
    return /^[A-Za-z0-9.-]{1,253}$/u.test(value) ? value : undefined;
}

function diagnostic(text: string): string | undefined {
    return sanitizeVerificationDiagnostic(text);
}

function suffix(details: string | undefined): string {
    return details === undefined ? "" : ` Details: ${details}`;
}

function at(target: VerificationTarget): string {
    if (target.host !== undefined) return ` at ${target.host}`;
    if (target.region !== undefined) return ` in ${target.region}`;
    return "";
}

function model(target: VerificationTarget): string {
    return target.modelId === null ? "" : ` with ${target.modelId}`;
}

function awsProfile(target: VerificationTarget): string {
    return target.awsProfile === undefined ? "" : ` for AWS profile ${quote(target.awsProfile)}`;
}

/** Configuration names shown in a message, bounded and unable to break their code span. */
function quote(value: string): string {
    return `\`${plain(value)}\``;
}

function plain(value: string): string {
    return truncate(value.replace(/[`\s]/gu, ""), 64);
}

function describeError(error: unknown): string {
    return error instanceof Error && error.message !== "" ? error.message : "An unknown error.";
}
