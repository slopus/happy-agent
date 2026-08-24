import { createHash, randomBytes } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import type { Project, ProjectAvatarAsset } from "../projects/index.js";
import type {
    HappyConnectionConfiguration,
    HappyCredentials,
    HappyEncryptionVariant,
} from "./HappyCredentials.js";
import { encryptHappyBlob } from "./crypto/decryptHappyBlob.js";
import {
    decryptHappyPayload,
    encryptHappyPayload,
    wrapHappyDataKey,
} from "./crypto/happyEncryption.js";
import { createHappyProjectSyncDatabase } from "./HappyProjectSyncDatabase.js";
import {
    happyProjectAvatarPreviewSchema,
    happyProjectMetadataSchema,
    type HappyProjectSyncState,
    type HappyProjectAvatarPreview,
    type HappyProjectMetadata,
} from "./HappyProjectSync.js";

const HTTP_TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

const remoteProjectSchema = Type.Object(
    {
        avatar: Type.Optional(Type.Unknown()),
        dataEncryptionKey: Type.Union([Type.String(), Type.Null()]),
        externalId: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
        metadata: Type.String({ minLength: 1 }),
        metadataVersion: Type.Number(),
    },
    { additionalProperties: true },
);

type RemoteProject = Static<typeof remoteProjectSchema>;

interface RemoteProjectIdentity {
    readonly created: boolean;
    readonly id: string;
}

export interface HappyProjectClientOptions {
    readonly avatarAsset: (
        ctx: Context,
        projectId: string,
    ) => Promise<ProjectAvatarAsset | undefined>;
    readonly configuration: HappyConnectionConfiguration;
    readonly context: Context;
    readonly fetch?: typeof fetch;
    readonly sync: ReturnType<typeof createHappyProjectSyncDatabase>;
    readonly version: string;
}

export class HappyProjectHttpError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`Happy answered with HTTP ${String(status)}.`);
        this.name = "HappyProjectHttpError";
        this.status = status;
    }
}

export class HappyProjectClient {
    readonly #locks: MapAsyncLock<string> = mapAsyncLock<string>();
    readonly #options: HappyProjectClientOptions;

    constructor(options: HappyProjectClientOptions) {
        this.#options = options;
    }

    /** Returns the stored remote id only for the current account and encryption variant. */
    async remoteProjectId(localProjectId: string): Promise<string | undefined> {
        const existing = await this.#options.sync.read(this.#options.context, localProjectId);
        return existing !== undefined && this.#belongsToCurrentAccount(existing)
            ? existing.remoteProjectId
            : undefined;
    }

    /** Converges one local project and returns its account-scoped remote identity. */
    async sync(
        project: Project,
        options: { readonly verifyRemote?: boolean } = {},
    ): Promise<string | undefined> {
        if (project.status === "archived") {
            // Keep the account-scoped mapping durable. Archive cleanup is deliberately deferred
            // to an explicitly authorized remote lifecycle operation.
            return undefined;
        }
        return await this.#locks.runInLock(this.#options.context, project.id, async () => {
            try {
                return await this.#sync(project, options.verifyRemote === true);
            } catch (error) {
                if (!(error instanceof HappyProjectHttpError) || error.status !== 404) throw error;
                const state = await this.#options.sync.read(this.#options.context, project.id);
                if (state?.remoteProjectId === undefined) throw error;
                await this.#options.sync.clearRemoteProject(
                    this.#options.context,
                    project.id,
                    Date.now(),
                );
                return await this.#sync(project, false);
            }
        });
    }

    async #sync(project: Project, verifyRemote: boolean): Promise<string> {
        const state = await this.#state(project.id);
        const metadata = projectMetadata(project);
        if (!Value.Check(happyProjectMetadataSchema, metadata)) {
            throw new Error("Happy project metadata is invalid.");
        }
        const metadataFingerprint = fingerprint(metadata);
        // Encode once: the fresh nonce makes exact ciphertext equality the create-vs-load signal.
        const encodedMetadata = encodePayload(
            state.encryptionKeyBase64,
            state.encryptionVariant,
            metadata,
        );
        const remote = await this.#createIfNeeded(state, encodedMetadata, verifyRemote);
        const remoteChanged = remote.id !== state.remoteProjectId;
        if (remoteChanged) {
            await this.#options.sync.setRemoteProject(
                this.#options.context,
                project.id,
                remote.id,
                Date.now(),
            );
        }
        if (remoteChanged || state.metadataFingerprint !== metadataFingerprint) {
            // A create-or-load response with older metadata needs a PATCH.
            if (!remote.created) await this.#patchMetadata(remote.id, encodedMetadata);
            await this.#options.sync.setMetadataFingerprint(
                this.#options.context,
                project.id,
                metadataFingerprint,
                Date.now(),
            );
        }
        await this.#syncAvatar(project, remote.id, state, remoteChanged);
        return remote.id;
    }

    /** Reads state only when its account and encryption variant still match. */
    async #state(localProjectId: string): Promise<HappyProjectSyncState> {
        const credentials = this.#options.configuration.credentials;
        const encryption = credentials.encryption;
        const existing = await this.#options.sync.read(this.#options.context, localProjectId);
        if (existing !== undefined && this.#belongsToCurrentAccount(existing)) return existing;
        const key =
            encryption.type === "legacy" ? encryption.secret : new Uint8Array(randomBytes(32));
        return await this.#options.sync.ensure(
            this.#options.context,
            {
                credentialFingerprint: projectCredentialFingerprint(credentials),
                encryptionKeyBase64: Buffer.from(key).toString("base64"),
                encryptionVariant: encryption.type,
                localProjectId,
            },
            Date.now(),
        );
    }

    #belongsToCurrentAccount(state: HappyProjectSyncState): boolean {
        const credentials = this.#options.configuration.credentials;
        return (
            state.credentialFingerprint === projectCredentialFingerprint(credentials) &&
            state.encryptionVariant === credentials.encryption.type
        );
    }

    async #createIfNeeded(
        state: HappyProjectSyncState,
        encodedMetadata: string,
        verifyRemote: boolean,
    ): Promise<RemoteProjectIdentity> {
        if (state.remoteProjectId !== undefined && !verifyRemote) {
            return { created: false, id: state.remoteProjectId };
        }
        const credentials = this.#options.configuration.credentials;
        const key = decodeKey(state.encryptionKeyBase64);
        const wrapped =
            credentials.encryption.type === "dataKey"
                ? Buffer.from(wrapHappyDataKey(key, credentials.encryption.publicKey)).toString(
                      "base64",
                  )
                : null;
        const body = await this.#jsonRequest(
            `${this.#options.configuration.serverUrl}/v1/projects`,
            "POST",
            {
                dataEncryptionKey: wrapped,
                externalId: state.localProjectId,
                metadata: encodedMetadata,
            },
        );
        const remote = readRemoteProject(body);
        this.#assertCompatibleRemote(remote, state, encodedMetadata);
        // Create-or-load may return an older project.
        return { created: remote.metadata === encodedMetadata, id: remote.id };
    }

    #assertCompatibleRemote(
        remote: RemoteProject,
        state: HappyProjectSyncState,
        encodedMetadata: string,
    ): void {
        const hasDataKey = typeof remote.dataEncryptionKey === "string";
        const expectedDataKey = state.encryptionVariant === "dataKey";
        if (hasDataKey !== expectedDataKey) {
            throw new Error("Happy returned a project encrypted with a different key.");
        }
        if (remote.metadata === encodedMetadata) return;
        const metadata = decryptHappyPayload(
            decodeKey(state.encryptionKeyBase64),
            state.encryptionVariant,
            new Uint8Array(Buffer.from(remote.metadata, "base64")),
        );
        if (!Value.Check(happyProjectMetadataSchema, metadata)) {
            throw new Error("Happy returned a project encrypted with a different key.");
        }
    }

    async #patchMetadata(remoteProjectId: string, metadata: string): Promise<void> {
        await this.#jsonRequest(
            `${this.#options.configuration.serverUrl}/v1/projects/${encodeURIComponent(remoteProjectId)}`,
            "PATCH",
            { metadata },
        );
    }

    async #syncAvatar(
        project: Project,
        remoteProjectId: string,
        state: HappyProjectSyncState,
        remoteChanged: boolean,
    ): Promise<void> {
        const asset = await this.#options.avatarAsset(this.#options.context, project.id);
        if (asset === undefined) {
            // A missing local asset does not authorize deleting the remote avatar.
            return;
        }
        if (!remoteChanged && state.avatarFingerprint === asset.contentHash) return;
        const encrypted = encryptHappyBlob({
            bytes: asset.bytes,
            encryptionKey: decodeKey(state.encryptionKeyBase64),
            encryptionVariant: state.encryptionVariant,
        });
        if (encrypted.byteLength > MAX_AVATAR_BYTES) {
            throw new Error("The encrypted project avatar is too large.");
        }
        const preview: HappyProjectAvatarPreview = {
            mimeType: asset.contentType,
            thumbhash: asset.thumbhash,
        };
        if (!Value.Check(happyProjectAvatarPreviewSchema, preview)) {
            throw new Error("Happy project avatar preview is invalid.");
        }
        const upload = await this.#jsonRequest(
            `${this.#options.configuration.serverUrl}/v1/projects/${encodeURIComponent(remoteProjectId)}/avatar/request-upload`,
            "POST",
            { size: encrypted.byteLength },
        );
        const instructions = readUploadInstructions(upload);
        await this.#upload(instructions, encrypted);
        const updated = await this.#jsonRequest(
            `${this.#options.configuration.serverUrl}/v1/projects/${encodeURIComponent(remoteProjectId)}/avatar`,
            "PATCH",
            {
                preview: encodePayload(state.encryptionKeyBase64, state.encryptionVariant, preview),
                ref: instructions.ref,
            },
        );
        const remote = readRemoteProject(updated);
        const version = avatarVersion(remote) ?? (state.avatarVersion ?? 0) + 1;
        await this.#options.sync.setAvatarFingerprint(
            this.#options.context,
            project.id,
            asset.contentHash,
            version,
            Date.now(),
        );
    }

    async #upload(instructions: UploadInstructions, bytes: Uint8Array): Promise<void> {
        const method = instructions.method.toUpperCase();
        const init: RequestInit =
            method === "POST" && instructions.formFields !== undefined
                ? {
                      body: uploadForm(instructions.formFields, bytes),
                      method,
                      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
                  }
                : {
                      body: bytes,
                      method,
                      headers: {
                          Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                          "Content-Type": "application/octet-stream",
                          "X-Happy-Client": `rig/${this.#options.version}`,
                      },
                      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
                  };
        const response = await (this.#options.fetch ?? fetch)(instructions.uploadUrl, init);
        if (!response.ok) throw new HappyProjectHttpError(response.status);
    }

    async #jsonRequest(
        url: string,
        method = "GET",
        body?: Record<string, unknown>,
    ): Promise<unknown> {
        const response = await (this.#options.fetch ?? fetch)(url, {
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: {
                Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                "Content-Type": "application/json",
                "X-Happy-Client": `rig/${this.#options.version}`,
            },
            method,
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!response.ok) throw new HappyProjectHttpError(response.status);
        if (response.status === 204) return {};
        return await response.json();
    }
}

interface UploadInstructions {
    readonly formFields?: Readonly<Record<string, string>>;
    readonly method: string;
    readonly ref: string;
    readonly uploadUrl: string;
}

function readUploadInstructions(value: unknown): UploadInstructions {
    const candidate = isRecord(value) && isRecord(value.upload) ? value.upload : value;
    if (
        !isRecord(candidate) ||
        typeof candidate.ref !== "string" ||
        typeof candidate.uploadUrl !== "string"
    ) {
        throw new Error("Happy returned project upload instructions it could not read.");
    }
    const formFields = readStringRecord(candidate.formFields);
    return {
        ...(formFields === undefined ? {} : { formFields }),
        method: typeof candidate.method === "string" ? candidate.method : "PUT",
        ref: candidate.ref,
        uploadUrl: candidate.uploadUrl,
    };
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        throw new Error("Happy returned invalid project upload form fields.");
    }
    const entries = Object.entries(value);
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
        throw new Error("Happy returned invalid project upload form fields.");
    }
    return Object.fromEntries(entries);
}

function uploadForm(fields: Readonly<Record<string, string>>, bytes: Uint8Array): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "avatar.enc");
    return form;
}

function readRemoteProject(value: unknown): RemoteProject {
    const candidate = isRecord(value) && value.project !== undefined ? value.project : value;
    if (!Value.Check(remoteProjectSchema, candidate)) {
        throw new Error("Happy returned a project Happy Agent could not read.");
    }
    return structuredClone(candidate);
}

function avatarVersion(project: RemoteProject): number | undefined {
    if (!isRecord(project.avatar) || typeof project.avatar.version !== "number") return undefined;
    return project.avatar.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectMetadata(project: Project): HappyProjectMetadata {
    return {
        kind: project.kind,
        name: project.name,
    };
}

function fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable for one account even when its bearer token or local machine key changes. */
function projectCredentialFingerprint(credentials: HappyCredentials): string {
    const encryption = credentials.encryption;
    return createHash("sha256")
        .update(encryption.type)
        .update(encryption.type === "dataKey" ? encryption.publicKey : encryption.secret)
        .digest("hex");
}

function encodePayload(keyBase64: string, variant: HappyEncryptionVariant, value: unknown): string {
    return Buffer.from(encryptHappyPayload(decodeKey(keyBase64), variant, value)).toString(
        "base64",
    );
}

function decodeKey(value: string): Uint8Array {
    const key = new Uint8Array(Buffer.from(value, "base64"));
    if (key.byteLength !== 32) throw new Error("Happy project encryption keys must be 32 bytes.");
    return key;
}
