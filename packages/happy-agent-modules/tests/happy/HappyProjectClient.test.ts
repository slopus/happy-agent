import { afterEach, describe, expect, it } from "vitest";

import type { Project, ProjectAvatarAsset } from "../../sources/projects/index.js";
import {
    createHappyProjectSyncDatabase,
    decryptHappyBlob,
    decryptHappyPayload,
    happyProjectSyncMigrations,
    HappyProjectClient,
    type HappyConnectionConfiguration,
} from "../../sources/happy/index.js";
import { decryptHappyAuthBundle } from "../../sources/happy/crypto/happyEncryption.js";
import { nobleBoxKeyPairFromSecretKey } from "../../sources/happy/crypto/nobleNaCl.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const SERVER = "https://api.happy.example";
const SECRET = new Uint8Array(32).fill(4);
const OTHER_SECRET = new Uint8Array(32).fill(5);
const HASH = "a".repeat(64);
const PROJECT = {
    id: "project-1",
    kind: "regular",
    name: "Happy Agent",
    status: "active",
} as unknown as Project;
const ASSET: ProjectAvatarAsset = {
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentHash: HASH,
    contentType: "image/webp",
    etag: `"${HASH}"`,
    height: 32,
    thumbhash: "AQIDBA==",
    width: 32,
};

const stores: ReturnType<typeof moduleDatabase>[] = [];

afterEach(() => {
    for (const store of stores.splice(0)) store.close();
});

function legacyConfiguration(token = "token-1", secret = SECRET): HappyConnectionConfiguration {
    return {
        credentialFingerprint: `ignored-${token}`,
        credentials: { encryption: { secret, type: "legacy" }, token },
        credentialsPath: "/tmp/happy/access.key",
        happyHome: "/tmp/happy",
        imported: false,
        machineId: "machine-1",
        serverUrl: SERVER,
    };
}

function dataKeyConfiguration(
    publicKey: Uint8Array,
    machineKey: Uint8Array,
): HappyConnectionConfiguration {
    return {
        ...legacyConfiguration(),
        credentials: { encryption: { machineKey, publicKey, type: "dataKey" }, token: "token-1" },
    };
}

function decryptJson(value: string, key: Uint8Array, variant: "legacy" | "dataKey") {
    return decryptHappyPayload(key, variant, new Uint8Array(Buffer.from(value, "base64")));
}

async function requestBody(body: RequestInit["body"]): Promise<unknown> {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return JSON.parse(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof FormData) return Object.fromEntries([...body.entries()]);
    return body;
}

function requiredString(record: Record<string, string>, key: string): string {
    const value = record[key];
    if (value === undefined) throw new Error(`Missing ${key}.`);
    return value;
}

interface RecordedRequest {
    body: unknown;
    headers: Headers;
    method: string;
    url: string;
}

function happyServer(mode: "local" | "s3" = "local") {
    const requests: RecordedRequest[] = [];
    const projects = new Map<string, Record<string, unknown>>();
    let nextId = 1;
    const byId = (url: string): Record<string, unknown> | undefined => {
        const id = url.slice(`${SERVER}/v1/projects/`.length).split("/")[0];
        return [...projects.values()].find((project) => project.id === id);
    };
    const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
        const url = input.toString();
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        const body = await requestBody(init.body);
        requests.push({ body, headers, method, url });
        if (url === `${SERVER}/v1/projects` && method === "POST") {
            const inputBody = body as Record<string, unknown>;
            const key = `${headers.get("authorization") ?? ""}\u0000${String(inputBody.externalId)}`;
            const existing = projects.get(key);
            // POST is create-or-load by account and external id.
            if (existing !== undefined) return Response.json(existing);
            const created = {
                avatar: null,
                dataEncryptionKey: inputBody.dataEncryptionKey,
                externalId: inputBody.externalId,
                id: `remote-project-${String(nextId++)}`,
                metadata: inputBody.metadata,
                metadataVersion: 1,
            };
            projects.set(key, created);
            return Response.json(created);
        }
        if (url.endsWith("/avatar/request-upload")) {
            const project = byId(url);
            if (project === undefined) return new Response(null, { status: 404 });
            const ref = `projects/${String(project.id)}/avatar/00000000-0000-4000-8000-000000000000.enc`;
            return Response.json(
                mode === "local"
                    ? {
                          method: "PUT",
                          ref,
                          uploadUrl: `${SERVER}/v1/projects/${String(project.id)}/avatar/avatar.enc`,
                      }
                    : {
                          formFields: { key: ref, policy: "opaque" },
                          method: "POST",
                          ref,
                          uploadUrl: "https://s3.example/upload",
                      },
            );
        }
        if (url.endsWith("/avatar") && method === "PATCH") {
            const project = byId(url);
            if (project === undefined) return new Response(null, { status: 404 });
            project.avatar = { ...(body as Record<string, unknown>), version: 1 };
            return Response.json(project);
        }
        if (url.includes("/v1/projects/") && method === "PATCH") {
            const project = byId(url);
            if (project === undefined) return new Response(null, { status: 404 });
            project.metadata = (body as Record<string, unknown>).metadata;
            project.metadataVersion = 2;
            return Response.json(project);
        }
        return Response.json({ ok: true });
    };
    const find = (id: string): Record<string, unknown> => {
        const project = [...projects.values()].find((candidate) => candidate.id === id);
        if (project === undefined) throw new Error(`No project ${id}.`);
        return project;
    };
    const remove = (id: string): void => {
        const entry = [...projects.entries()].find(([, project]) => project.id === id);
        if (entry === undefined) throw new Error(`No project ${id}.`);
        projects.delete(entry[0]);
    };
    return { fetch, find, projects, remove, requests };
}

type HappyServer = ReturnType<typeof happyServer>;

function clientFor(
    configuration: HappyConnectionConfiguration,
    store: ReturnType<typeof moduleDatabase>,
    sync: ReturnType<typeof createHappyProjectSyncDatabase>,
    server: HappyServer,
): HappyProjectClient {
    return new HappyProjectClient({
        avatarAsset: async () => ASSET,
        configuration,
        context: store.context,
        fetch: server.fetch as typeof globalThis.fetch,
        sync,
        version: "1.2.3",
    });
}

async function fixture(
    configuration = legacyConfiguration(),
    mode: "local" | "s3" = "local",
    server: HappyServer = happyServer(mode),
) {
    const store = moduleDatabase(happyProjectSyncMigrations, "happy-project-client");
    stores.push(store);
    await store.ready;
    const sync = createHappyProjectSyncDatabase();
    const client = clientFor(configuration, store, sync, server);
    return { client, requests: server.requests, server, store, sync };
}

function metadataPatches(requests: readonly RecordedRequest[]): RecordedRequest[] {
    return requests.filter(
        (request) => request.method === "PATCH" && !request.url.endsWith("/avatar"),
    );
}

describe("Happy project synchronization", () => {
    it("creates canonical encrypted metadata and an authenticated encrypted local avatar", async () => {
        const { client, requests } = await fixture();
        await client.sync(PROJECT);

        const create = requests.find((request) => request.url === `${SERVER}/v1/projects`)!;
        expect(create.body).not.toHaveProperty("tag");
        expect(
            decryptJson(
                requiredString(create.body as Record<string, string>, "metadata"),
                SECRET,
                "legacy",
            ),
        ).toEqual({ kind: "regular", name: "Happy Agent" });

        const upload = requests.find((request) => request.method === "PUT")!;
        expect(upload.headers.get("authorization")).toBe("Bearer token-1");
        expect(
            decryptHappyBlob({
                bundle: upload.body as Uint8Array,
                encryptionKey: SECRET,
                encryptionVariant: "legacy",
            }),
        ).toEqual(ASSET.bytes);

        const activation = requests.find(
            (request) => request.url.endsWith("/avatar") && request.method === "PATCH",
        )!;
        expect(
            decryptJson(
                requiredString(activation.body as Record<string, string>, "preview"),
                SECRET,
                "legacy",
            ),
        ).toEqual({ mimeType: "image/webp", thumbhash: ASSET.thumbhash });
        const count = requests.length;
        await client.sync(PROJECT);
        expect(requests).toHaveLength(count);
    });

    it("wraps a distinct project key to the account instead of reusing the machine key", async () => {
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(8));
        const machineKey = new Uint8Array(32).fill(9);
        const { client, requests } = await fixture(
            dataKeyConfiguration(account.publicKey, machineKey),
        );
        await client.sync(PROJECT);
        const body = requests[0]!.body as Record<string, string>;
        const wrapped = new Uint8Array(
            Buffer.from(requiredString(body, "dataEncryptionKey"), "base64"),
        );
        const projectKey = decryptHappyAuthBundle(wrapped.slice(1), account.secretKey)!;
        expect(projectKey).not.toEqual(machineKey);
        expect(decryptJson(requiredString(body, "metadata"), projectKey, "dataKey")).toEqual({
            kind: "regular",
            name: "Happy Agent",
        });
    });

    it("uses the complete presigned S3 form without leaking the bearer token", async () => {
        const { client, requests } = await fixture(legacyConfiguration(), "s3");
        await client.sync(PROJECT);
        const upload = requests.find((request) => request.url === "https://s3.example/upload")!;
        expect(upload.headers.get("authorization")).toBeNull();
        expect(upload.body).toMatchObject({
            key: "projects/remote-project-1/avatar/00000000-0000-4000-8000-000000000000.enc",
            policy: "opaque",
        });
        expect((upload.body as Record<string, unknown>).file).toBeInstanceOf(Blob);
    });

    it("keeps its project identity across bearer-token rotation for the same account", async () => {
        const first = await fixture();
        await first.client.sync(PROJECT);
        const client = new HappyProjectClient({
            avatarAsset: async () => ASSET,
            configuration: legacyConfiguration("token-2"),
            context: first.store.context,
            fetch: (async () => {
                throw new Error("token rotation should not recreate the project");
            }) as typeof fetch,
            sync: first.sync,
            version: "1.2.3",
        });
        await expect(client.sync(PROJECT)).resolves.toBe("remote-project-1");
    });

    it("never reuses remote state recorded under a different account", async () => {
        const { client, server, store, sync } = await fixture();
        await expect(client.sync(PROJECT)).resolves.toBe("remote-project-1");
        await expect(client.remoteProjectId(PROJECT.id)).resolves.toBe("remote-project-1");

        // Re-pair the same local project to another account.
        const rotated = clientFor(
            legacyConfiguration("token-2", OTHER_SECRET),
            store,
            sync,
            server,
        );

        // A mismatched row must not leak its remote id to callers.
        await expect(rotated.remoteProjectId(PROJECT.id)).resolves.toBeUndefined();

        await expect(rotated.sync(PROJECT)).resolves.toBe("remote-project-2");
        await expect(rotated.remoteProjectId(PROJECT.id)).resolves.toBe("remote-project-2");
        expect(server.projects.size).toBe(2);
        const created = server.find("remote-project-2");
        expect(decryptJson(created.metadata as string, OTHER_SECRET, "legacy")).toEqual({
            kind: "regular",
            name: "Happy Agent",
        });
    });

    it("refuses to overwrite an existing project with a regenerated data key", async () => {
        const account = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(8));
        const configuration = dataKeyConfiguration(account.publicKey, new Uint8Array(32).fill(9));
        const server = happyServer();
        const first = await fixture(configuration, "local", server);
        await first.client.sync(PROJECT);
        const create = server.requests[0]!.body as Record<string, string>;
        const originalKey = decryptHappyAuthBundle(
            new Uint8Array(
                Buffer.from(requiredString(create, "dataEncryptionKey"), "base64"),
            ).slice(1),
            account.secretKey,
        )!;
        const originalMetadata = server.find("remote-project-1").metadata as string;

        // Losing only the local sync row creates a different random project key.
        const second = await fixture(configuration, "local", server);
        server.requests.length = 0;
        await expect(second.client.sync(PROJECT)).rejects.toThrow(
            "Happy returned a project encrypted with a different key.",
        );
        expect(metadataPatches(server.requests)).toHaveLength(0);
        expect(server.find("remote-project-1").metadata).toBe(originalMetadata);
        expect(decryptJson(originalMetadata, originalKey, "dataKey")).toEqual({
            kind: "regular",
            name: "Happy Agent",
        });
    });

    it("recreates a remotely deleted project and restores its encrypted avatar", async () => {
        const { client, server } = await fixture();
        await expect(client.sync(PROJECT)).resolves.toBe("remote-project-1");
        server.remove("remote-project-1");

        const renamed = { ...PROJECT, name: "Renamed" } as unknown as Project;
        await expect(client.sync(renamed)).resolves.toBe("remote-project-2");
        await expect(client.remoteProjectId(PROJECT.id)).resolves.toBe("remote-project-2");
        expect(server.find("remote-project-2").avatar).not.toBeNull();

        server.remove("remote-project-2");
        await expect(client.sync(renamed, { verifyRemote: true })).resolves.toBe(
            "remote-project-3",
        );
        expect(server.find("remote-project-3").avatar).not.toBeNull();
    });

    it("serializes concurrent updates to the same project", async () => {
        const { server, store, sync } = await fixture();
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstRelease = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let avatarReads = 0;
        const client = new HappyProjectClient({
            avatarAsset: async () => {
                avatarReads += 1;
                if (avatarReads === 1) {
                    markFirstStarted();
                    await firstRelease;
                }
                return ASSET;
            },
            configuration: legacyConfiguration(),
            context: store.context,
            fetch: server.fetch as typeof fetch,
            sync,
            version: "1.2.3",
        });

        const first = client.sync(PROJECT);
        await firstStarted;
        const renamed = { ...PROJECT, name: "Renamed" } as unknown as Project;
        const second = client.sync(renamed);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(avatarReads).toBe(1);
        releaseFirst();
        await Promise.all([first, second]);

        expect(avatarReads).toBe(2);
        expect(
            decryptJson(server.find("remote-project-1").metadata as string, SECRET, "legacy"),
        ).toEqual({ kind: "regular", name: "Renamed" });
    });

    it("pushes metadata when creation answered with a project that already existed", async () => {
        const server = happyServer();
        const first = await fixture(legacyConfiguration(), "local", server);
        await first.client.sync(PROJECT);
        // The first create must not issue a second metadata write.
        expect(metadataPatches(server.requests)).toHaveLength(0);

        // A fresh local row receives the existing project with older metadata.
        const renamed = { ...PROJECT, name: "Renamed" } as unknown as Project;
        const second = await fixture(legacyConfiguration(), "local", server);
        await expect(second.client.sync(renamed)).resolves.toBe("remote-project-1");

        const patches = metadataPatches(server.requests);
        expect(patches).toHaveLength(1);
        expect(patches[0]!.url).toBe(`${SERVER}/v1/projects/remote-project-1`);
        expect(server.projects.size).toBe(1);
        const stored = server.find("remote-project-1");
        expect(decryptJson(stored.metadata as string, SECRET, "legacy")).toEqual({
            kind: "regular",
            name: "Renamed",
        });

        // The stored fingerprint suppresses a repeat PATCH.
        await second.client.sync(renamed);
        expect(metadataPatches(server.requests)).toHaveLength(1);
    });
});
