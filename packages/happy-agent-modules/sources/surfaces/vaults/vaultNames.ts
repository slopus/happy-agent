import { SurfaceError } from "../SurfaceError.js";

/** How deep below the root an entry may sit. */
export const MAX_VAULT_DEPTH = 64;

// oxlint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\\x00-\x1f\x7f]/;

/**
 * A name as the vault stores it: NFC, 1–255 bytes of UTF-8, no `/`, `\`, or control character,
 * and not `.` or `..`. Anything else is refused with a reason a person can act on.
 */
export function normalizeVaultName(name: string): string {
    const normalized = name.normalize("NFC");
    if (normalized.length === 0) throw invalidName("A name cannot be empty.");
    if (normalized === "." || normalized === "..")
        throw invalidName(`"${normalized}" cannot be used as a name.`);
    if (FORBIDDEN.test(normalized))
        throw invalidName(
            `${JSON.stringify(normalized)} holds a slash, a backslash, or a control character, which names cannot.`,
        );
    if (Buffer.byteLength(normalized, "utf8") > 255)
        throw invalidName("A name can be at most 255 bytes long.");
    return normalized;
}

/** Two names collide when their keys are equal: NFC, then Unicode default lowercasing. */
export function vaultNameKey(name: string): string {
    return name.normalize("NFC").toLowerCase();
}

/**
 * The segments a vault path walks through, from the root down, as written. `/` alone names the
 * root and gives none; a trailing `/` is ignored. Segments are matched against entry names by
 * their keys; those past an artifact entry name a file inside it and keep their exact bytes.
 */
export function vaultPathSegments(path: string): string[] {
    if (!path.startsWith("/"))
        throw invalidName(`A vault path starts with "/", such as "/Reports/summary.pdf".`);
    const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (trimmed === "/") return [];
    const segments = trimmed.slice(1).split("/");
    if (segments.some((segment) => segment.length === 0))
        throw invalidName(`${JSON.stringify(path)} has an empty segment between two slashes.`);
    return segments;
}

/** A path from names, root first. */
export function vaultPath(names: readonly string[]): string {
    return `/${names.join("/")}`;
}

function invalidName(message: string): SurfaceError {
    return new SurfaceError("invalid_request", message);
}
