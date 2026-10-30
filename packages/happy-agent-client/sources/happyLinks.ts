/**
 * Happy links: ordinary Markdown links to Happy URLs, written inline in an agent's Markdown reply.
 * `[Q3 report](happy://artifacts/<id>)` names an entity, and clients that can resolve it show its
 * live title in place of the label. `[Foo.tsx:42](happy://agents/<agentId>/files/Foo.tsx#L42)`
 * names a file in the workspace it lives in, so the link opens the same file wherever the text is
 * read. This one implementation is shared by the daemon and every client so they agree on exactly
 * what a link names.
 *
 * Files have two equally valid forms. Markdown written for agents uses `happy://…/files/…`; the
 * API's canonical form is `happy-file://agents/<agentId>/Foo.tsx#L42`, with the path straight after
 * the target. Both parse to the same `HappyFileLink`, and `formatHappyFileUrl` writes either.
 *
 * The Happy mobile app registers `happy://` for its deep links (`happy://session/…`,
 * `happy://terminal?…`, and others). Every host here is a plural noun, which no mobile route uses,
 * so the two never collide. The grammar is strict: anything else under `happy://` is malformed and
 * never partly interpreted, and no client hands a Happy URL to the operating system.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The entity kinds a `happy://` URL can name. */
export const HAPPY_REFERENCE_KINDS = [
    "artifact",
    "agent",
    "workspace",
    "project",
    "service",
    "surface",
    "user",
] as const;
export type HappyReferenceKind = (typeof HAPPY_REFERENCE_KINDS)[number];

/** The scheme of every Happy URL in Markdown. */
export const HAPPY_URL_SCHEME = "happy";

/** The scheme of the API's canonical file URL, `happy-file://agents/<agentId>/<path>`. */
export const HAPPY_FILE_URL_SCHEME = "happy-file";

/** Which form `formatHappyFileUrl` writes: `happy://…/files/…`, or `happy-file://…`. */
export type HappyFileUrlScheme = typeof HAPPY_URL_SCHEME | typeof HAPPY_FILE_URL_SCHEME;

/** The longest URL, in characters. */
export const MAX_HAPPY_URL_LENGTH = 4096;

const ID_PATTERN = "[A-Za-z0-9_-]{1,128}";
const VERSION_PATTERN = "[1-9][0-9]{0,8}";
const LINES_PATTERN = `#L(${VERSION_PATTERN})(?:-L(${VERSION_PATTERN}))?`;
const ENCODED_PATH_PATTERN = String.raw`[A-Za-z0-9\-._~!$&'*+,;=:@%/]+`;
const MAX_NUMBER = 999_999_999;
// A decoded path segment: never `.` or `..`, and no `/`, `\`, or control character.
const SEGMENT = String.raw`(?!\.\.?(?:/|$))[^/\\\u0000-\u001f\u007f-\u009f]+`;

const idSchema = Type.String({ pattern: `^${ID_PATTERN}$` });
const lineSchema = Type.Integer({ minimum: 1, maximum: MAX_NUMBER });

/**
 * One entity. `version` names an artifact version and appears only on artifacts. `workspaceId` is
 * the workspace a service runs in; a `happy://` service URL always carries it, and only a legacy
 * tag can name a service without it.
 */
export const happyReferenceSchema = Type.Object(
    {
        kind: Type.Union(HAPPY_REFERENCE_KINDS.map((kind) => Type.Literal(kind))),
        id: idSchema,
        version: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_NUMBER })),
        workspaceId: Type.Optional(idSchema),
    },
    { additionalProperties: false },
);
export type HappyReference = Static<typeof happyReferenceSchema>;

/**
 * One file. `path` is decoded and relative to the workspace root; `lines` is inclusive, so `#L42`
 * is `{ start: 42, end: 42 }`. An agent target means that agent's workspace.
 */
export const happyFileLinkSchema = Type.Object(
    {
        target: Type.Union([
            Type.Object(
                { type: Type.Literal("agent"), agentId: idSchema },
                { additionalProperties: false },
            ),
            Type.Object(
                { type: Type.Literal("workspace"), workspaceId: idSchema },
                { additionalProperties: false },
            ),
        ]),
        path: Type.String({
            maxLength: MAX_HAPPY_URL_LENGTH,
            pattern: `^${SEGMENT}(?:/${SEGMENT})*$`,
        }),
        lines: Type.Optional(
            Type.Object({ start: lineSchema, end: lineSchema }, { additionalProperties: false }),
        ),
    },
    { additionalProperties: false },
);
export type HappyFileLink = Static<typeof happyFileLinkSchema>;

/** What a `happy://` URL names: an entity or a file. */
export type HappyLink =
    | { type: "reference"; reference: HappyReference }
    | { type: "file"; file: HappyFileLink };

const HOSTS: Record<HappyReferenceKind, string> = {
    artifact: "artifacts",
    agent: "agents",
    workspace: "workspaces",
    project: "projects",
    service: "services",
    surface: "surfaces",
    user: "users",
};

const ENTITY_URL = new RegExp(
    `^happy://(artifacts|agents|workspaces|projects|surfaces|users)/(${ID_PATTERN})` +
        `(?:\\?version=(${VERSION_PATTERN}))?$`,
);
const SERVICE_URL = new RegExp(`^happy://workspaces/(${ID_PATTERN})/services/(${ID_PATTERN})$`);
const FILE_URL = new RegExp(
    `^happy://(agents|workspaces)/(${ID_PATTERN})/files/(${ENCODED_PATH_PATTERN})(?:${LINES_PATTERN})?$`,
);
/** The `happy-file://` form, which puts the path straight after the target. */
const HAPPY_FILE_URL = new RegExp(
    `^happy-file://(agents|workspaces)/(${ID_PATTERN})/(${ENCODED_PATH_PATTERN})(?:${LINES_PATTERN})?$`,
);
const HAPPY_URL = /^happy(?:-file)?:/i;

/**
 * Whether `url` uses the `happy` or `happy-file` scheme, in any letter case and whether or not it
 * is well-formed. Such a URL is opened only by Happy, never by the operating
 * system or a browser.
 */
export function isHappyUrl(url: string): boolean {
    return HAPPY_URL.test(url);
}

/**
 * Parses a `happy://` or `happy-file://` URL, and returns undefined for anything that is not exactly
 * a well-formed link.
 */
export function parseHappyUrl(url: string): HappyLink | undefined {
    if (url.length > MAX_HAPPY_URL_LENGTH) return undefined;
    const entity = ENTITY_URL.exec(url);
    if (entity !== null) {
        const [, host, id = "", version] = entity;
        const kind = HAPPY_REFERENCE_KINDS.find((candidate) => HOSTS[candidate] === host);
        if (kind === undefined || (version !== undefined && kind !== "artifact")) return undefined;
        return {
            type: "reference",
            reference: { kind, id, ...(version === undefined ? {} : { version: Number(version) }) },
        };
    }
    const service = SERVICE_URL.exec(url);
    if (service !== null) {
        const [, workspaceId = "", id = ""] = service;
        return { type: "reference", reference: { kind: "service", id, workspaceId } };
    }
    const file = FILE_URL.exec(url) ?? HAPPY_FILE_URL.exec(url);
    if (file === null) return undefined;
    const [, host, id = "", encodedPath = "", start, end] = file;
    const path = decodePath(encodedPath);
    if (path === undefined) return undefined;
    const link: HappyFileLink = {
        target:
            host === "agents"
                ? { type: "agent", agentId: id }
                : { type: "workspace", workspaceId: id },
        path,
    };
    if (start !== undefined) link.lines = { start: Number(start), end: Number(end ?? start) };
    return isValidFileLink(link) ? { type: "file", file: link } : undefined;
}

/**
 * The canonical URL for a link. Throws a `TypeError` for a link the grammar cannot express, such as
 * a version on anything but an artifact or a service without its workspace.
 */
export function formatHappyUrl(link: HappyLink): string {
    return link.type === "reference"
        ? formatHappyReferenceUrl(link.reference)
        : formatHappyFileUrl(link.file);
}

/** The canonical URL for an entity, such as `happy://artifacts/<id>?version=2`. */
export function formatHappyReferenceUrl(reference: HappyReference): string {
    if (
        !Value.Check(happyReferenceSchema, reference) ||
        (reference.version !== undefined && reference.kind !== "artifact") ||
        (reference.workspaceId === undefined) === (reference.kind === "service")
    ) {
        throw new TypeError("The Happy reference is invalid.");
    }
    if (reference.kind === "service") {
        return `happy://workspaces/${reference.workspaceId ?? ""}/services/${reference.id}`;
    }
    const version = reference.version === undefined ? "" : `?version=${String(reference.version)}`;
    return `happy://${HOSTS[reference.kind]}/${reference.id}${version}`;
}

/**
 * The canonical URL for a file: every byte of a path segment but the unreserved characters is
 * percent-encoded, and a single line is written `#L42`. `scheme` picks the form: `happy`, the
 * default, writes `happy://agents/<id>/files/<path>` for Markdown; `happy-file` writes the API's
 * `happy-file://agents/<id>/<path>`.
 */
export function formatHappyFileUrl(
    file: HappyFileLink,
    scheme: HappyFileUrlScheme = HAPPY_URL_SCHEME,
): string {
    if (!isValidFileLink(file)) throw new TypeError("The Happy file link is invalid.");
    const target =
        file.target.type === "agent"
            ? `agents/${file.target.agentId}`
            : `workspaces/${file.target.workspaceId}`;
    let path: string;
    try {
        path = file.path.split("/").map(encodeSegment).join("/");
    } catch {
        // A lone surrogate has no UTF-8 encoding.
        throw new TypeError("The Happy file link is invalid.");
    }
    const lines =
        file.lines === undefined
            ? ""
            : file.lines.start === file.lines.end
              ? `#L${String(file.lines.start)}`
              : `#L${String(file.lines.start)}-L${String(file.lines.end)}`;
    const url =
        scheme === HAPPY_FILE_URL_SCHEME
            ? `${HAPPY_FILE_URL_SCHEME}://${target}/${path}${lines}`
            : `${HAPPY_URL_SCHEME}://${target}/files/${path}${lines}`;
    if (url.length > MAX_HAPPY_URL_LENGTH) throw new TypeError("The Happy file link is too long.");
    return url;
}

/**
 * A ready-to-paste Markdown link, `[label](happy://…)`, with the label escaped as literal text. An
 * entity link may leave the label empty; clients fill in the live title.
 */
export function formatHappyMarkdownLink(link: HappyLink, label = ""): string {
    return `[${escapeMarkdownText(label)}](${formatHappyUrl(link)})`;
}

/** Words that stand in for an entity nobody can resolve, such as "an unavailable artifact". */
export function happyReferencePlaceholder(reference: HappyReference): string {
    return `an unavailable ${reference.kind}`;
}

export function isKnownHappyReferenceKind(kind: string): kind is HappyReferenceKind {
    return (HAPPY_REFERENCE_KINDS as readonly string[]).includes(kind);
}

/** Escapes text so Markdown shows it literally on one line, as a label in running prose. */
export function escapeMarkdownText(text: string): string {
    return text.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

function decodePath(encodedPath: string): string | undefined {
    const segments: string[] = [];
    for (const segment of encodedPath.split("/")) {
        if (segment === "") return undefined;
        // Also rejects a `%` that starts no escape, and bytes that are not UTF-8.
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            return undefined;
        }
        // An encoded `%2F` is never a separator, and no file name holds a `/`.
        if (decoded.includes("/")) return undefined;
        segments.push(decoded);
    }
    return segments.join("/");
}

function isValidFileLink(link: HappyFileLink): boolean {
    return (
        Value.Check(happyFileLinkSchema, link) &&
        (link.lines === undefined || link.lines.end >= link.lines.start)
    );
}

function encodeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}
