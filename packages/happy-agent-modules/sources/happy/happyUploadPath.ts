/** Where files a person attaches are saved in the agent's folder, as direct chats save them. */
export const HAPPY_UPLOADS_DIRECTORY = ".happy-uploads";

/** Pictures are named for what they are, because file tools tell an image by its extension. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};

/** The longest name, in UTF-8 bytes, the phones give their own uploads. */
const MAX_NAME_BYTES = 120;

/**
 * The workspace-relative path one attachment of a message is saved at:
 * `.happy-uploads/<message>/<n>-<name>`, numbered from 1 in the order the phone sent them.
 *
 * The phone's name is only a hint. It can be a path, a signed URL, or nothing useful, so only a
 * bounded, portable last segment survives, the same rule the phones apply to their own uploads.
 */
export function happyUploadPath(
    messageId: string,
    index: number,
    name: string,
    mimeType: string,
): string {
    const leaf = portableLeaf(name);
    const own = /\.([A-Za-z0-9]{1,16})$/.exec(leaf);
    const type = mimeType.toLowerCase();
    const subtype = /^[a-z0-9]{1,8}$/.exec(type.split("/")[1] ?? "")?.[0];
    const extension = IMAGE_EXTENSIONS[type] ?? own?.[1] ?? subtype;
    const suffix = extension === undefined ? "" : `.${extension}`;
    const stem = bounded(
        own === null ? leaf : leaf.slice(0, own.index),
        MAX_NAME_BYTES - suffix.length,
    );
    return `${HAPPY_UPLOADS_DIRECTORY}/${messageId}/${String(index + 1)}-${stem || "attachment"}${suffix}`;
}

function portableLeaf(name: string): string {
    if (name.startsWith("data:")) return "";
    const segment = name
        .replaceAll("\\", "/")
        .split("/")
        .findLast((part) => part.length > 0);
    return trimEdges(
        (segment ?? "")
            .split(/[?#]/)[0]!
            .replaceAll(/[<>:"|*]/g, "_")
            .replaceAll(/\p{Cc}/gu, ""),
    );
}

/** At most `bytes` of UTF-8, cut between characters, without edge dots or spaces. */
function bounded(value: string, bytes: number): string {
    let output = "";
    for (const character of value) {
        if (Buffer.byteLength(output + character) > bytes) break;
        output += character;
    }
    return trimEdges(output);
}

function trimEdges(value: string): string {
    return value.replace(/^[\s.]+|[\s.]+$/gu, "");
}
