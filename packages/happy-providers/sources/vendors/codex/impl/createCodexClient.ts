import OpenAI, { APIError } from "openai";
import { bedrock, type AwsCredentialsProvider } from "openai/providers/bedrock/aws";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

import { isBedrockCredential, type CodexProviderCredential } from "@/vendors/VendorCredential.js";
import type { CodexBedrockTransport } from "@/vendors/codex/CodexProvider.js";

/**
 * Bedrock's client, taught to keep the diagnostic AWS actually sent.
 *
 * The SDK builds an error message from a nested `error` object, which is the OpenAI envelope. AWS
 * reports a top-level `message` instead, so the SDK sees a body it does not recognize, discards
 * it, and says there was none. Presenting the body as the error preserves the only description of
 * the failure a person can act on.
 */
class BedrockOpenAI extends OpenAI {
    protected override makeStatusError(
        status: number,
        body: object,
        message: string | undefined,
        headers: Headers,
    ): APIError {
        // The SDK reads the failure out of `body.error`, so an AWS body has to be moved there.
        const describesItself =
            typeof body === "object" &&
            body !== null &&
            !("error" in body) &&
            typeof (body as { message?: unknown }).message === "string";
        return super.makeStatusError(
            status,
            describesItself ? { error: body } : body,
            message,
            headers,
        );
    }
}

export function createCodexClient(options: {
    bedrockTransport?: CodexBedrockTransport;
    credential: CodexProviderCredential;
    endpoint: string;
    installationId: string;
    region: string;
    sessionId: string;
    userAgent: string;
    windowId: string;
}): OpenAI {
    if (isBedrockCredential(options.credential)) {
        const defaultHeaders = {
            ...(options.bedrockTransport === "runtime"
                ? {}
                : { "x-amzn-mantle-client-agent": "codex" }),
            "x-codex-beta-features": "remote_compaction_v2",
            originator: "codex_exec",
            "user-agent": options.userAgent,
            "session-id": options.sessionId,
            "thread-id": options.sessionId,
            "x-client-request-id": options.sessionId,
            "x-codex-installation-id": options.installationId,
            "x-codex-window-id": options.windowId,
        };
        if (options.bedrockTransport === "runtime" && options.credential.name === "bedrock-aws") {
            return new BedrockOpenAI({
                apiKey: "bedrock-runtime-sigv4",
                baseURL: options.endpoint,
                defaultHeaders,
                fetch: createBedrockRuntimeFetch(
                    options.credential.credential.provider,
                    options.region,
                ),
                maxRetries: 0,
            });
        }
        const authentication =
            options.credential.name === "bedrock-bearer-token"
                ? { apiKey: options.credential.credential.bearerToken }
                : { credentialProvider: options.credential.credential.provider };
        return new BedrockOpenAI({
            defaultHeaders,
            maxRetries: 0,
            provider: bedrock({
                ...authentication,
                baseURL: options.endpoint,
                region: options.region,
            }),
        });
    }
    const accountId =
        options.credential.name === "codex-session"
            ? options.credential.credential.accountId
            : undefined;
    if (options.credential.name === "codex-session" && accountId === undefined) {
        throw new Error("Codex authentication is missing a ChatGPT account ID.");
    }
    return new OpenAI({
        apiKey:
            options.credential.name === "codex-session"
                ? options.credential.credential.accessToken
                : options.credential.credential.apiKey,
        baseURL:
            options.credential.name === "codex-session"
                ? `${options.endpoint.replace(/\/$/u, "")}/codex`
                : options.endpoint,
        defaultHeaders: {
            ...(accountId === undefined ? {} : { "chatgpt-account-id": accountId }),
            originator: "codex_exec",
            "user-agent": options.userAgent,
            "session-id": options.sessionId,
            "thread-id": options.sessionId,
            "x-client-request-id": options.sessionId,
            "x-codex-beta-features": "remote_compaction_v2",
            "x-codex-installation-id": options.installationId,
            "x-codex-window-id": options.windowId,
        },
        maxRetries: 0,
    });
}

function createBedrockRuntimeFetch(
    credentials: AwsCredentialsProvider,
    region: string,
): typeof fetch {
    const signer = new SignatureV4({
        credentials: async () => await credentials(),
        region,
        service: "bedrock",
        sha256: Hash.bind(null, "sha256"),
    });
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const method = (
            init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        headers.delete("authorization");
        headers.delete("x-amz-content-sha256");
        headers.delete("x-amz-date");
        headers.delete("x-amz-security-token");
        headers.set("host", url.host);
        const body = signableBody(init?.body);
        const signed = await signer.sign({
            protocol: url.protocol,
            hostname: url.hostname,
            ...(url.port ? { port: Number(url.port) } : {}),
            method,
            path: url.pathname,
            query: requestQuery(url),
            headers: Object.fromEntries(headers.entries()),
            ...(body === undefined ? {} : { body }),
        });
        return await globalThis.fetch(url, {
            ...init,
            headers: signed.headers,
            method,
            redirect: "manual",
        });
    };
}

function requestQuery(url: URL): Record<string, string | string[]> {
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of url.searchParams) {
        const existing = query[name];
        query[name] =
            existing === undefined
                ? value
                : typeof existing === "string"
                  ? [existing, value]
                  : [...existing, value];
    }
    return query;
}

function signableBody(
    body: RequestInit["body"],
): string | ArrayBuffer | ArrayBufferView | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return body;
    }
    throw new Error("Bedrock Runtime SigV4 requests require a replayable body.");
}
