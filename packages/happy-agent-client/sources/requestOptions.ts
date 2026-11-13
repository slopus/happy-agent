/**
 * What a caller passes alongside a request, rather than over the wire.
 *
 * These carry `AbortSignal`s and raw bytes, which are runtime objects and not
 * JSON, so they are declared as ordinary interfaces: there is no wire value
 * here for a schema to validate.
 */

/** Options every request accepts. */
export interface RequestOptions {
    /** Cancels the request; the rejection is the signal's abort reason. */
    signal?: AbortSignal | undefined;
}

/** Options for a mutation the daemon guards with `If-Match`. */
export interface VersionedRequestOptions extends RequestOptions {
    /** The `version` the client last saw, sent as the `If-Match` header. */
    ifMatch: string;
}

/** Options for a mutation that honors `If-Match` without requiring it. */
export interface OptionallyVersionedRequestOptions extends RequestOptions {
    /** The `version` the client last saw, sent as the `If-Match` header. */
    ifMatch?: string | undefined;
}

/** Options for a read that may answer `304 Not Modified`. */
export interface ConditionalRequestOptions extends RequestOptions {
    /** The `ETag` the client already holds, sent as `If-None-Match`. */
    ifNoneMatch?: string | undefined;
}

/** An image the daemon accepts as a picture. */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** Bytes to upload, in whichever form the caller already holds them. */
export type BinaryData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

/** An image being uploaded. */
export interface ImageUpload {
    contentType: ImageMimeType;
    data: BinaryData;
}

/** Binary file or image bytes served by the daemon. */
export interface BinaryContent {
    contentType: string;
    data: ArrayBuffer;
    /** The entity tag, when the endpoint serves conditional requests. */
    etag: string | null;
}

/** One artifact file's bytes; its name and media type come from the path it is placed at. */
export interface ArtifactFileUpload {
    data: BinaryData;
}

/**
 * One byte range of a file: from `start` through `end` inclusive, from `start` to the end of the
 * file when `end` is omitted, or the last `suffix` bytes.
 */
export type ByteRange =
    | { start: number; end?: number | undefined; suffix?: never }
    | { suffix: number; start?: never; end?: never };

/** Options for reading one artifact file. */
export interface ArtifactFileRequestOptions extends ConditionalRequestOptions {
    /** Read only these bytes, as a video player does to seek. */
    range?: ByteRange | undefined;
}

/** An artifact file's bytes, whole or one range of them. */
export interface ArtifactFileContent extends BinaryContent {
    /** The served `Content-Range` when a range was requested and answered, otherwise `null`. */
    contentRange: string | null;
}

/** Options for reading a vault file or a file of a vault artifact. */
export type VaultFileRequestOptions = ArtifactFileRequestOptions;

/** A vault file's bytes, whole or one range of them. */
export type VaultFileContent = ArtifactFileContent;

/**
 * Bytes for a vault upload. With `start` they are placed there, in an upload of `size` bytes;
 * without it they are the whole upload.
 */
export type VaultUploadChunk =
    | { data: BinaryData; start: number; size: number }
    | { data: BinaryData; start?: undefined; size?: undefined };

/** Options for reading one tool call's media item. */
export interface ToolCallMediaRequestOptions extends ConditionalRequestOptions {
    /** Read only these bytes, as a video player does to seek. */
    range?: ByteRange | undefined;
}

/** A tool call's media item bytes, whole or one range of them. */
export interface ToolCallMediaContent extends BinaryContent {
    /** The served `Content-Range` when a range was requested and answered, otherwise `null`. */
    contentRange: string | null;
}

/** A file to upload whole, in one request. */
export interface AttachmentFile {
    /** The file name shown with it, 1–255 characters. */
    name: string;
    data: Uint8Array<ArrayBuffer>;
    /** The file's media type; omitted, the daemon goes by the name. */
    contentType?: string | undefined;
}

/**
 * One chunk of an attachment uploaded in parts: `data` placed at `start` in a file of `size`
 * bytes. Without `data` the request only asks where the upload stands.
 */
export interface AttachmentChunk {
    name: string;
    size: number;
    start?: number | undefined;
    data?: Uint8Array<ArrayBuffer> | undefined;
    contentType?: string | undefined;
}

/** How `attachFile` sends a file. */
export interface AttachFileOptions extends RequestOptions {
    /** The largest file sent in one request: 8 MiB unless said otherwise. */
    directLimit?: number | undefined;
    /** How many bytes each chunk of a larger file carries: 8 MiB unless said otherwise. */
    chunkSize?: number | undefined;
}
