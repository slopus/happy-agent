import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    type ClusterSecret,
    type ClusterSecretGrant,
    clusterSecretDeleteResponseSchema,
    clusterSecretGrantListResponseSchema,
    clusterSecretGrantResponseSchema,
    clusterSecretListQuerySchema,
    clusterSecretListResponseSchema,
    clusterSecretMutationRequestSchema,
    clusterSecretResponseSchema,
    clusterSecretRevokeResponseSchema,
    clusterSecretSchema,
    createClusterSecretRequestSchema,
    updateClusterSecretRequestSchema,
} from "../sources/protocol/clusterSecrets.js";
import {
    clusterSecretAttachedPayloadSchema,
    clusterSecretCreatedPayloadSchema,
    clusterSecretDetachedPayloadSchema,
    clusterSecretRemovedPayloadSchema,
    clusterSecretsChangedPayloadSchema,
    clusterSecretUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import { clusterSecretSchema as publicClusterSecretSchema } from "../sources/index.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const createdAt = 1_755_400_000_000;
const token = "glpat-0123456789abcdef";

/** Shaped like `stripe_view` in happy-cluster `crates/hc-api/tests/secrets.rs`. */
const stripe: ClusterSecret = {
    access: { attach: true, manage: true, use: true },
    createdAt,
    description: "Billing",
    id: "c1k2s3e4c5r6e7t8i9d0a1b2",
    name: "Stripe",
    owner: "team",
    public: {
        algorithm: { headers: [{ name: "Authorization", prefix: "Bearer " }], kind: "headers" },
        targets: [{ host: "api.stripe.com", pathPrefixes: ["/v1"] }],
    },
    roles: { member: { hidden: false, level: "use" } },
    type: "endpoint",
    updatedAt: createdAt,
    uses: ["egress"],
    version,
};

const deployKey: ClusterSecret = {
    access: { attach: true, manage: true, use: true },
    createdAt,
    description: "",
    id: "d2k3s4e5c6r7e8t9i0d1a2b3",
    name: "Deploy box",
    owner: "me",
    public: {
        fingerprint: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8",
        hosts: ["deploy.acme.dev"],
        publicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    },
    type: "ssh_key",
    updatedAt: createdAt,
    uses: ["ssh"],
    version,
};

const gitlab: ClusterSecret = {
    access: { attach: false, manage: false, use: false },
    createdAt,
    description: "Read access to infrastructure repositories",
    id: "g3k4s5e6c7r8e9t0i1d2a3b4",
    name: "GitLab deploy token",
    owner: "team",
    public: {
        method: { kind: "token", username: "oauth2" },
        operations: ["read"],
        repos: ["acme/infra/*"],
        server: "gitlab.com",
    },
    type: "git_credential",
    updatedAt: createdAt,
    uses: ["git"],
    version,
};

const deployEnvironment: ClusterSecret = {
    access: { attach: true, manage: false, use: true },
    createdAt,
    description: "Deployment credentials",
    id: "e4k5s6e7c8r9e0t1i2d3a4b5",
    name: "Deploy environment",
    owner: "team",
    public: { variables: ["DEPLOY_API_TOKEN", "DEPLOY_ORGANIZATION"] },
    type: "environment",
    updatedAt: createdAt,
    uses: ["environment", "mcp"],
    version,
};

const grant: ClusterSecretGrant = {
    createdAt,
    grantedBy: "userone",
    secretId: stripe.id,
    target: { id: "agentone", type: "agent" },
};

describe("cluster secrets protocol", () => {
    it("accepts every catalog type's metadata and rejects values or mismatched types", () => {
        expect(publicClusterSecretSchema).toBe(clusterSecretSchema);
        for (const secret of [stripe, deployKey, gitlab, deployEnvironment]) {
            expect(Value.Check(clusterSecretSchema, secret)).toBe(true);
        }
        expect(
            Value.Check(clusterSecretListResponseSchema, {
                nextCursor: `${createdAt}.${gitlab.id}`,
                secrets: [stripe, deployKey, gitlab, deployEnvironment],
            }),
        ).toBe(true);
        expect(Value.Check(clusterSecretResponseSchema, { secret: stripe })).toBe(true);
        expect(Value.Check(clusterSecretSchema, { ...stripe, futureMetadata: true })).toBe(true);

        expect(
            Value.Check(clusterSecretSchema, {
                ...stripe,
                material: { Authorization: "sk_live_0123456789abcdef" },
            }),
        ).toBe(false);
        expect(Value.Check(clusterSecretSchema, { ...stripe, type: "ssh_key" })).toBe(false);
        expect(Value.Check(clusterSecretSchema, { ...deployKey, uses: ["egress"] })).toBe(false);
        expect(Value.Check(clusterSecretSchema, { ...stripe, type: "inference_provider" })).toBe(
            false,
        );
        expect(Value.Check(clusterSecretSchema, { ...gitlab, owner: "organization" })).toBe(false);
    });

    it("couples create material to the type and a git credential's method", () => {
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                description: "Billing",
                material: { Authorization: "sk_live_0123456789abcdef" },
                name: "Stripe",
                public: stripe.public,
                roles: { member: { level: "use" }, viewer: { hidden: true } },
                type: "endpoint",
                uses: ["egress"],
            }),
        ).toBe(true);
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                material: { token },
                name: "GitLab deploy token",
                public: gitlab.public,
                type: "git_credential",
                uses: ["git"],
            }),
        ).toBe(true);
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                material: { passphrase: null, privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" },
                name: "acme.dev deploy key",
                owner: "me",
                public: {
                    method: {
                        kind: "ssh_key",
                        knownHosts: ["[git.acme.dev]:2222 ssh-ed25519 AAAA"],
                    },
                    operations: ["read", "write", "sign"],
                    port: 2222,
                    server: "git.acme.dev",
                },
                type: "git_credential",
                uses: ["git"],
            }),
        ).toBe(true);
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                material: { DEPLOY_API_TOKEN: "raw-value" },
                name: "Deploy environment",
                type: "environment",
                uses: ["environment"],
            }),
        ).toBe(true);

        expect(
            Value.Check(createClusterSecretRequestSchema, {
                material: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" },
                name: "GitLab deploy token",
                public: gitlab.public,
                type: "git_credential",
                uses: ["git"],
            }),
        ).toBe(false);
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                material: { Authorization: "too-short" },
                name: "Stripe",
                public: stripe.public,
                type: "endpoint",
                uses: ["egress"],
            }),
        ).toBe(false);
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                id: stripe.id,
                material: { Authorization: "sk_live_0123456789abcdef" },
                name: "Stripe",
                public: stripe.public,
                type: "endpoint",
                uses: ["egress"],
            }),
        ).toBe(false);
        expect(
            Value.Check(createClusterSecretRequestSchema, {
                material: { DEPLOY_API_TOKEN: "raw-value" },
                name: "Deploy environment",
                type: "environment",
                uses: ["git"],
            }),
        ).toBe(false);
    });

    it("accepts a new public only together with material", () => {
        expect(Value.Check(updateClusterSecretRequestSchema, { name: "Stripe live" })).toBe(true);
        expect(
            Value.Check(updateClusterSecretRequestSchema, {
                material: { Authorization: "sk_live_rotated_0123456789" },
                mutationId: "update-1",
            }),
        ).toBe(true);
        expect(
            Value.Check(updateClusterSecretRequestSchema, {
                material: { Authorization: "sk_live_rotated_0123456789" },
                public: { ...stripe.public, targets: [{ host: "api.stripe.com" }] },
            }),
        ).toBe(true);
        expect(
            Value.Check(updateClusterSecretRequestSchema, {
                public: { ...stripe.public, targets: [{ host: "api.stripe.com" }] },
            }),
        ).toBe(false);
        expect(
            Value.Check(updateClusterSecretRequestSchema, {
                name: "Stripe live",
                public: stripe.public,
            }),
        ).toBe(false);
        expect(Value.Check(updateClusterSecretRequestSchema, { mutationId: "update-1" })).toBe(
            false,
        );
        expect(
            Value.Check(updateClusterSecretRequestSchema, { name: "Stripe", type: "ssh_key" }),
        ).toBe(false);
    });

    it("accepts the cluster's list, delete, and grant shapes", () => {
        expect(Value.Check(clusterSecretListQuerySchema, { cursor: "x", limit: 100 })).toBe(true);
        expect(Value.Check(clusterSecretListQuerySchema, { limit: 101 })).toBe(false);
        expect(Value.Check(clusterSecretListQuerySchema, { targetType: "agent" })).toBe(false);
        expect(Value.Check(clusterSecretMutationRequestSchema, {})).toBe(true);
        expect(Value.Check(clusterSecretMutationRequestSchema, { force: true })).toBe(false);
        expect(
            Value.Check(clusterSecretDeleteResponseSchema, { deleted: true, secretId: stripe.id }),
        ).toBe(true);
        expect(Value.Check(clusterSecretGrantListResponseSchema, { grants: [grant] })).toBe(true);
        expect(
            Value.Check(clusterSecretGrantListResponseSchema, {
                grants: [{ ...grant, target: { id: "projectone", type: "project" } }],
            }),
        ).toBe(false);
        expect(
            Value.Check(clusterSecretGrantResponseSchema, {
                created: true,
                grant,
                version: nextVersion,
            }),
        ).toBe(true);
        expect(
            Value.Check(clusterSecretRevokeResponseSchema, {
                grant: null,
                revoked: false,
                version,
            }),
        ).toBe(true);
    });

    it("parses every cluster secret event, with team changes naming no secret", async () => {
        const target = { id: "agentone", type: "agent" } as const;
        const events: HappyAgentEvent[] = [
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e70",
                occurredAt: createdAt,
                payload: { mutationId: "create-1", secretId: deployKey.id, version },
                type: "cluster_secret.created",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e71",
                occurredAt: createdAt + 1,
                payload: { previousVersion: version, secretId: deployKey.id, version: nextVersion },
                type: "cluster_secret.updated",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e72",
                occurredAt: createdAt + 2,
                payload: {
                    mutationId: "grant-1",
                    previousVersion: version,
                    secretId: deployKey.id,
                    target,
                    version: nextVersion,
                },
                type: "cluster_secret.attached",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e73",
                occurredAt: createdAt + 3,
                payload: {
                    previousVersion: version,
                    secretId: deployKey.id,
                    target,
                    version: nextVersion,
                },
                type: "cluster_secret.detached",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e74",
                occurredAt: createdAt + 4,
                payload: { previousVersion: nextVersion, secretId: deployKey.id },
                type: "cluster_secret.removed",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e75",
                occurredAt: createdAt + 5,
                payload: { mutationId: "update-2" },
                type: "cluster_secrets.changed",
            },
        ];

        expect(Value.Check(clusterSecretCreatedPayloadSchema, events[0]!.payload)).toBe(true);
        expect(Value.Check(clusterSecretUpdatedPayloadSchema, events[1]!.payload)).toBe(true);
        expect(Value.Check(clusterSecretAttachedPayloadSchema, events[2]!.payload)).toBe(true);
        expect(Value.Check(clusterSecretDetachedPayloadSchema, events[3]!.payload)).toBe(true);
        expect(Value.Check(clusterSecretRemovedPayloadSchema, events[4]!.payload)).toBe(true);
        expect(Value.Check(clusterSecretsChangedPayloadSchema, events[5]!.payload)).toBe(true);
        expect(Value.Check(clusterSecretsChangedPayloadSchema, {})).toBe(true);
        expect(
            Value.Check(clusterSecretAttachedPayloadSchema, {
                ...(events[2]!.payload as object),
                target: { id: "projectone", type: "project" },
            }),
        ).toBe(false);
        expect(Value.Check(clusterSecretCreatedPayloadSchema, { secret: deployKey })).toBe(false);

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
        expect(frames.map((frame) => frame.kind === "event" && frame.event)).toEqual(events);
    });

    it("calls every cluster secret route with encoded paths, bodies, and If-Match", async () => {
        const list = { nextCursor: null, secrets: [stripe] };
        const response = { secret: stripe };
        const deleted = { deleted: true, secretId: stripe.id };
        const granted = { created: true, grant, version: nextVersion };
        const revoked = { grant, revoked: true, version: nextVersion };
        const { fetch, requests } = stubFetch((request) => {
            if (request.url.includes("/grants/")) {
                return request.method === "PUT" ? json(granted, 201) : json(revoked);
            }
            if (request.url.endsWith("/grants")) {
                return json({ grants: [grant] });
            }
            if (request.method === "GET" && request.url.includes("/v0/cluster/secrets?")) {
                return json(list);
            }
            if (request.method === "DELETE") {
                return json(deleted);
            }
            return json(response, request.method === "POST" ? 201 : 200);
        });
        const client = new HappyAgentClient({
            endpoint: "http://cluster.local",
            fetch,
            token: "t",
        });
        const target = { id: "agent/one", type: "agent" } as const;

        await expect(
            client.listClusterSecrets({ cursor: "1755400000000.abc", limit: 25 }),
        ).resolves.toEqual(list);
        await expect(client.getClusterSecret("secret/one")).resolves.toEqual(response);
        await expect(
            client.createClusterSecret({
                material: { token },
                name: "GitLab deploy token",
                public: { method: { kind: "token" }, operations: ["read"], server: "gitlab.com" },
                type: "git_credential",
                uses: ["git"],
            }),
        ).resolves.toEqual(response);
        await expect(
            client.updateClusterSecret(
                "secret/one",
                { material: { token }, mutationId: "update-1" },
                { ifMatch: version },
            ),
        ).resolves.toEqual(response);
        await expect(
            client.deleteClusterSecret(
                "secret/one",
                { mutationId: "delete-1" },
                { ifMatch: version },
            ),
        ).resolves.toEqual(deleted);
        await expect(client.deleteClusterSecret("secret/one")).resolves.toEqual(deleted);
        await expect(client.listClusterSecretGrants("secret/one")).resolves.toEqual({
            grants: [grant],
        });
        await expect(
            client.grantClusterSecret("secret/one", target, { mutationId: "grant-1" }),
        ).resolves.toEqual(granted);
        await expect(client.revokeClusterSecret("secret/one", target)).resolves.toEqual(revoked);

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
                url: "http://cluster.local/v0/cluster/secrets?cursor=1755400000000.abc&limit=25",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone",
            },
            {
                body: JSON.stringify({
                    material: { token },
                    name: "GitLab deploy token",
                    public: {
                        method: { kind: "token" },
                        operations: ["read"],
                        server: "gitlab.com",
                    },
                    type: "git_credential",
                    uses: ["git"],
                }),
                ifMatch: null,
                method: "POST",
                url: "http://cluster.local/v0/cluster/secrets",
            },
            {
                body: JSON.stringify({ material: { token }, mutationId: "update-1" }),
                ifMatch: version,
                method: "PATCH",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone",
            },
            {
                body: JSON.stringify({ mutationId: "delete-1" }),
                ifMatch: version,
                method: "DELETE",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone",
            },
            {
                body: JSON.stringify({}),
                ifMatch: null,
                method: "DELETE",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone/grants",
            },
            {
                body: JSON.stringify({ mutationId: "grant-1" }),
                ifMatch: null,
                method: "PUT",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone/grants/agent/agent%2Fone",
            },
            {
                body: JSON.stringify({}),
                ifMatch: null,
                method: "DELETE",
                url: "http://cluster.local/v0/cluster/secrets/secret%2Fone/grants/agent/agent%2Fone",
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
