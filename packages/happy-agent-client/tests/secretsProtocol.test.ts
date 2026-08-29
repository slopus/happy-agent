import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    secretAttachedPayloadSchema,
    secretCreatedPayloadSchema,
    secretDetachedPayloadSchema,
    secretRemovedPayloadSchema,
    secretUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import {
    createSecretRequestSchema,
    type Secret,
    type SecretAttachment,
    secretAttachmentListResponseSchema,
    secretAttachmentMutationRequestSchema,
    secretAttachmentSchema,
    secretAttachResponseSchema,
    secretAttachResultSchema,
    secretDetachResponseSchema,
    secretEnvironmentPatchSchema,
    secretEnvironmentSchema,
    secretListQuerySchema,
    secretListResponseSchema,
    secretResponseSchema,
    secretSchema,
    updateSecretRequestSchema,
} from "../sources/protocol/secrets.js";
import { secretSchema as publicSecretSchema } from "../sources/index.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const updatedAt = 1_755_400_000_000;

const secret: Secret = {
    availableToAgents: true,
    createdAt: updatedAt - 1_000,
    description: "Deployment API credentials",
    environmentVariables: ["DEPLOY_API_TOKEN", "DEPLOY_ORGANIZATION"],
    id: "secret1",
    managed: false,
    updatedAt,
    version,
};

const attachment: SecretAttachment = {
    createdAt: updatedAt,
    id: "attachment1",
    secretId: secret.id,
    target: { id: "workspace1", type: "workspace" },
};

describe("secrets protocol", () => {
    it("validates safe metadata while rejecting value-bearing response fields", () => {
        expect(publicSecretSchema).toBe(secretSchema);
        expect(Value.Check(secretSchema, secret)).toBe(true);
        expect(Value.Check(secretResponseSchema, { secret })).toBe(true);
        expect(Value.Check(secretListResponseSchema, { nextCursor: null, secrets: [secret] })).toBe(
            true,
        );
        expect(Value.Check(secretSchema, { ...secret, environment: { TOKEN: "value" } })).toBe(
            false,
        );
        expect(Value.Check(secretSchema, { ...secret, values: { TOKEN: "value" } })).toBe(false);
        expect(Value.Check(secretSchema, { ...secret, futureMetadata: true })).toBe(true);
        expect(Value.Check(secretSchema, { ...secret, description: "   " })).toBe(false);
        expect(
            Value.Check(secretSchema, {
                ...secret,
                environmentVariables: ["VALID", "not-valid"],
            }),
        ).toBe(false);
    });

    it("validates write-only bundles, partial updates, and paired target filters", () => {
        expect(
            Value.Check(createSecretRequestSchema, {
                availableToAgents: true,
                description: "Deployment API credentials",
                environment: { DEPLOY_API_TOKEN: "raw-value" },
                id: "secret1",
                mutationId: "create-1",
            }),
        ).toBe(true);
        expect(Value.Check(secretEnvironmentSchema, {})).toBe(false);
        expect(Value.Check(secretEnvironmentSchema, { "NOT-VALID": "value" })).toBe(false);
        expect(Value.Check(secretEnvironmentSchema, { TOKEN: "contains\u0000nul" })).toBe(false);
        expect(Value.Check(secretEnvironmentPatchSchema, { OLD_TOKEN: null })).toBe(true);
        expect(
            Value.Check(updateSecretRequestSchema, {
                environment: { DEPLOY_API_TOKEN: "rotated", DEPLOY_ORGANIZATION: null },
                mutationId: "update-1",
            }),
        ).toBe(true);
        expect(Value.Check(updateSecretRequestSchema, { description: "Rotated credentials" })).toBe(
            true,
        );
        expect(Value.Check(updateSecretRequestSchema, { availableToAgents: false })).toBe(true);
        expect(Value.Check(updateSecretRequestSchema, { mutationId: "update-1" })).toBe(false);
        expect(
            Value.Check(updateSecretRequestSchema, {
                description: "Rotated credentials",
                unexpected: true,
            }),
        ).toBe(false);

        expect(Value.Check(secretListQuerySchema, {})).toBe(true);
        expect(
            Value.Check(secretListQuerySchema, {
                cursor: "secret0",
                limit: 100,
                targetId: "project1",
                targetType: "project",
            }),
        ).toBe(true);
        expect(Value.Check(secretListQuerySchema, { targetType: "project" })).toBe(false);
        expect(Value.Check(secretListQuerySchema, { targetId: "project1" })).toBe(false);
        expect(Value.Check(secretListQuerySchema, { limit: 101 })).toBe(false);
    });

    it("validates immutable attachment and mutation response shapes", () => {
        expect(Value.Check(secretAttachmentSchema, attachment)).toBe(true);
        expect(
            Value.Check(secretAttachmentSchema, {
                ...attachment,
                target: { id: "workspace1", type: "organization" },
            }),
        ).toBe(false);
        expect(
            Value.Check(secretAttachmentListResponseSchema, {
                attachments: [attachment],
                nextCursor: null,
            }),
        ).toBe(true);
        expect(Value.Check(secretAttachmentMutationRequestSchema, {})).toBe(true);
        expect(Value.Check(secretAttachResponseSchema, { attachment, created: true })).toBe(true);
        expect(
            Value.Check(secretAttachResultSchema, {
                attachment,
                created: false,
                httpStatus: 200,
            }),
        ).toBe(true);
        expect(Value.Check(secretDetachResponseSchema, { attachment: null, detached: false })).toBe(
            true,
        );
    });

    it("parses every metadata-only secret event", async () => {
        const events: HappyAgentEvent[] = [
            {
                cursor: version,
                occurredAt: updatedAt,
                payload: { mutationId: "create-1", secret },
                type: "secret.created",
            },
            {
                cursor: nextVersion,
                occurredAt: updatedAt + 1,
                payload: {
                    changes: { updatedAt: updatedAt + 1 },
                    mutationId: "update-1",
                    previousVersion: version,
                    secretId: secret.id,
                    version: nextVersion,
                },
                type: "secret.updated",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e70",
                occurredAt: updatedAt + 2,
                payload: { attachment, mutationId: "attach-1" },
                type: "secret.attached",
            },
            {
                cursor: "01991f3a-8d2f-7000-8000-3a0b2c4d5e71",
                occurredAt: updatedAt + 3,
                payload: { attachment, mutationId: "detach-1" },
                type: "secret.detached",
            },
            {
                cursor: "01991f3a-9d2f-7000-8000-3a0b2c4d5e72",
                occurredAt: updatedAt + 4,
                payload: { previousVersion: nextVersion, secretId: secret.id },
                type: "secret.removed",
            },
        ];

        expect(Value.Check(secretCreatedPayloadSchema, events[0]!.payload)).toBe(true);
        expect(Value.Check(secretUpdatedPayloadSchema, events[1]!.payload)).toBe(true);
        expect(Value.Check(secretAttachedPayloadSchema, events[2]!.payload)).toBe(true);
        expect(Value.Check(secretDetachedPayloadSchema, events[3]!.payload)).toBe(true);
        expect(Value.Check(secretRemovedPayloadSchema, events[4]!.payload)).toBe(true);
        expect(
            Value.Check(secretUpdatedPayloadSchema, {
                ...(events[1]!.payload as object),
                changes: { environment: { TOKEN: "value" }, updatedAt },
            }),
        ).toBe(false);

        const frames = [];
        for await (const frame of readEventStream(
            streamOf(
                events
                    .map(
                        (event) =>
                            `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                    )
                    .join(""),
            ),
        )) {
            frames.push(frame);
        }
        expect(frames.map((frame) => frame.kind === "event" && frame.event.type)).toEqual([
            "secret.created",
            "secret.updated",
            "secret.attached",
            "secret.detached",
            "secret.removed",
        ]);
    });

    it("calls every secret endpoint with encoded targets, write-only bodies, and guards", async () => {
        const list = { nextCursor: null, secrets: [secret] };
        const response = { secret };
        const attachmentList = { attachments: [attachment], nextCursor: null };
        const { fetch, requests } = stubFetch((request) => {
            if (request.method === "GET" && request.url.includes("/attachments?")) {
                return json(attachmentList);
            }
            if (request.method === "GET" && request.url.includes("/v0/secrets?")) {
                return json(list);
            }
            if (request.method === "PUT") {
                return json({ attachment, created: true }, 201);
            }
            if (request.method === "DELETE") {
                return json({ attachment, detached: true });
            }
            return json(response, request.method === "POST" ? 201 : 200);
        });
        const client = new HappyAgentClient({ endpoint: "http://agent.local", fetch, token: "t" });

        await expect(
            client.listSecrets({
                cursor: "secret0",
                limit: 25,
                targetId: "project/one",
                targetType: "project",
            }),
        ).resolves.toEqual(list);
        await expect(client.getSecret("secret/one")).resolves.toEqual(response);
        await expect(
            client.createSecret({
                description: secret.description,
                environment: { DEPLOY_API_TOKEN: "raw-value" },
                mutationId: "create-1",
            }),
        ).resolves.toEqual(response);
        await expect(
            client.updateSecret(
                "secret/one",
                { environment: { DEPLOY_API_TOKEN: "rotated" }, mutationId: "update-1" },
                { ifMatch: version },
            ),
        ).resolves.toEqual(response);
        await expect(
            client.listSecretAttachments("secret/one", { cursor: "attachment0", limit: 20 }),
        ).resolves.toEqual(attachmentList);
        await expect(
            client.attachSecret(
                "secret/one",
                { id: "workspace/one", type: "workspace" },
                { mutationId: "attach-1" },
            ),
        ).resolves.toEqual({ attachment, created: true, httpStatus: 201 });
        await expect(
            client.detachSecret(
                "secret/one",
                { id: "workspace/one", type: "workspace" },
                { mutationId: "detach-1" },
            ),
        ).resolves.toEqual({ attachment, detached: true });

        expect(
            requests.map(({ body, headers, method, url }) => ({
                body,
                ifMatch: headers.get("if-match"),
                method,
                url,
            })),
        ).toEqual([
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/secrets?cursor=secret0&limit=25&targetId=project%2Fone&targetType=project",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/secrets/secret%2Fone",
            },
            {
                body: JSON.stringify({
                    description: secret.description,
                    environment: { DEPLOY_API_TOKEN: "raw-value" },
                    mutationId: "create-1",
                }),
                ifMatch: null,
                method: "POST",
                url: "http://agent.local/v0/secrets",
            },
            {
                body: JSON.stringify({
                    environment: { DEPLOY_API_TOKEN: "rotated" },
                    mutationId: "update-1",
                }),
                ifMatch: version,
                method: "PATCH",
                url: "http://agent.local/v0/secrets/secret%2Fone",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/secrets/secret%2Fone/attachments?cursor=attachment0&limit=20",
            },
            {
                body: JSON.stringify({ mutationId: "attach-1" }),
                ifMatch: null,
                method: "PUT",
                url: "http://agent.local/v0/secrets/secret%2Fone/attachments/workspace/workspace%2Fone",
            },
            {
                body: JSON.stringify({ mutationId: "detach-1" }),
                ifMatch: null,
                method: "DELETE",
                url: "http://agent.local/v0/secrets/secret%2Fone/attachments/workspace/workspace%2Fone",
            },
        ]);
    });
});

interface RecordedRequest {
    body: string | null;
    headers: Headers;
    method: string;
    url: string;
}

function stubFetch(answer: (request: RecordedRequest) => Response): {
    fetch: typeof globalThis.fetch;
    requests: RecordedRequest[];
} {
    const requests: RecordedRequest[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = {
            body: typeof init?.body === "string" ? init.body : null,
            headers: new Headers(init?.headers),
            method: init?.method ?? "GET",
            url: input.toString(),
        };
        requests.push(request);
        return answer(request);
    };
    return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
    });
}

function streamOf(text: string): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}
