import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BedrockAwsCredential } from "@/vendors/bedrock/BedrockAwsCredential.js";
import { createAnthropicBedrockClient } from "@/vendors/bedrock/impl/createAnthropicBedrockClient.js";
import { createCodexClient } from "@/vendors/codex/impl/createCodexClient.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("BedrockAwsCredential", () => {
    it("loads AWS credentials through a profile credential_process", async () => {
        const fixture = await writeCredentialProcessFixture();

        const credential = await BedrockAwsCredential.tryLoad(fixture.loadOptions);

        expect(credential).not.toBeNull();
        expect(credential?.name).toBe("bedrock-aws");
        await expect(credential?.credential.provider()).resolves.toMatchObject({
            accessKeyId: "PROCESS_ACCESS_KEY",
            secretAccessKey: "process-secret-key",
            sessionToken: "process-session-token",
        });
    });

    it("signs OpenAI Bedrock requests with credentials returned by credential_process", async () => {
        const fixture = await writeCredentialProcessFixture();
        const credential = await BedrockAwsCredential.tryLoad(fixture.loadOptions);
        if (credential === null) throw new Error("Expected an AWS Bedrock credential.");
        const request = await captureRequest(async (endpoint) => {
            const client = createCodexClient({
                credential,
                endpoint: `${endpoint}/openai/v1`,
                installationId: "installation-id",
                region: "us-west-2",
                sessionId: "session-id",
                userAgent: "credential-process-test",
                windowId: "window-id",
            });
            await client.responses.create({ input: "hello", model: "openai.gpt-5.6-sol" });
        });

        expect(request.headers.authorization).toContain("Credential=PROCESS_ACCESS_KEY/");
        expect(request.headers.authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
        expect(request.headers["x-amz-security-token"]).toBe("process-session-token");
    });

    it.each([
        { service: "bedrock-mantle", transport: "mantle" as const },
        { service: "bedrock", transport: "runtime" as const },
    ])(
        "signs Anthropic Bedrock $transport requests with credentials returned by credential_process",
        async ({ service, transport }) => {
            const fixture = await writeCredentialProcessFixture();
            const credential = await BedrockAwsCredential.tryLoad(fixture.loadOptions);
            if (credential === null) throw new Error("Expected an AWS Bedrock credential.");
            const request = await captureRequest(async (endpoint) => {
                const client = createAnthropicBedrockClient({
                    credential,
                    endpoint: `${endpoint}/anthropic`,
                    region: "us-west-2",
                    transport,
                });
                await client.beta.messages.create({
                    max_tokens: 16,
                    messages: [{ content: "hello", role: "user" }],
                    model: "anthropic.claude-sonnet-5",
                });
            });

            expect(request.headers.authorization).toContain("Credential=PROCESS_ACCESS_KEY/");
            expect(request.headers.authorization).toContain(`/us-west-2/${service}/aws4_request`);
            expect(request.headers["x-amz-security-token"]).toBe("process-session-token");
        },
    );
});

async function writeCredentialProcessFixture(): Promise<{
    loadOptions: {
        configFilepath: string;
        credentialsFilepath: string;
        profile: string;
    };
}> {
    const directory = await mkdtemp(join(tmpdir(), "rig-bedrock-credential-process-"));
    temporaryDirectories.push(directory);
    const configFilepath = join(directory, "config");
    const credentialsFilepath = join(directory, "credentials");
    const processFilepath = join(directory, "credentials.mjs");
    await writeFile(
        processFilepath,
        `console.log(JSON.stringify(${JSON.stringify({
            AccessKeyId: "PROCESS_ACCESS_KEY",
            Expiration: "2099-01-01T00:00:00.000Z",
            SecretAccessKey: "process-secret-key",
            SessionToken: "process-session-token",
            Version: 1,
        })}));\n`,
    );
    await writeFile(
        configFilepath,
        `[profile process-test]\ncredential_process = ${shellArgument(process.execPath)} ${shellArgument(processFilepath)}\n`,
    );
    await writeFile(credentialsFilepath, "");
    return {
        loadOptions: {
            configFilepath,
            credentialsFilepath,
            profile: "process-test",
        },
    };
}

async function captureRequest(run: (endpoint: string) => Promise<void>): Promise<{
    headers: Record<string, string | undefined>;
}> {
    let resolveRequest:
        | ((value: { headers: Record<string, string | undefined> }) => void)
        | undefined;
    const captured = new Promise<{ headers: Record<string, string | undefined> }>((resolve) => {
        resolveRequest = resolve;
    });
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
            // Drain the signed request before answering.
        }
        resolveRequest?.({
            headers: Object.fromEntries(
                Object.entries(request.headers).map(([name, value]) => [
                    name,
                    Array.isArray(value) ? value.join(", ") : value,
                ]),
            ),
        });
        const anthropic = request.url?.includes("/anthropic/") === true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify(
                anthropic
                    ? {
                          content: [{ text: "ok", type: "text" }],
                          id: "message-id",
                          model: "anthropic.claude-sonnet-5",
                          role: "assistant",
                          stop_reason: "end_turn",
                          stop_sequence: null,
                          type: "message",
                          usage: { input_tokens: 1, output_tokens: 1 },
                      }
                    : {
                          created_at: 0,
                          id: "response-id",
                          model: "openai.gpt-5.6-sol",
                          object: "response",
                          output: [],
                          status: "completed",
                      },
            ),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        server.close();
        throw new Error("Missing Bedrock credential-process test server port.");
    }
    try {
        await run(`http://127.0.0.1:${address.port}`);
        return await captured;
    } finally {
        server.close();
    }
}

function shellArgument(value: string): string {
    if (process.platform === "win32") return `"${value}"`;
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
