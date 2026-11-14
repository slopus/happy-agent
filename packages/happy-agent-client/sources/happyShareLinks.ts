/**
 * Share links: an instance link carried in the fragment of an `https` URL on link.happy.page, so it
 * works wherever an ordinary web address does and opens the Happy app from a browser.
 *
 *     https://link.happy.page/#1/<instanceId>/<rest>[?<param>=<value>&…]
 *
 * opens `happy://<instanceId>/<rest>`, the instance link `happyLinks.ts` defines. The parameters
 * are `as` (what an agent is, for display), `version` (an artifact's), and `lines` (a file's);
 * nothing else, no titles and no actions. The grammar is the page's own (`link.happy.page/src/link.ts`
 * in slopus/happy-link): anything else is not a share link at all and is never partly interpreted,
 * and the link it opens is always rebuilt from the parsed one, so it is canonical. Agents and the
 * daemon write every Happy link in this form; readers keep accepting `happy://` too.
 */

import { formatHappyUrl, type HappyLink, parseHappyUrl } from "./happyLinks.js";

/** Where share links live; everything after `#` stays in the browser. */
export const HAPPY_SHARE_LINK_ORIGIN = "https://link.happy.page";

/** What an agent is: a task's, a bot's, a subtask, a subagent, or a session. Display only. */
export const HAPPY_SHARE_LINK_ROLES = ["task", "bot", "subtask", "subagent", "session"] as const;
export type HappyShareLinkRole = (typeof HAPPY_SHARE_LINK_ROLES)[number];

/** What a share link carries: always an instance link, and for an agent, what it is. */
export interface HappyShareLink {
    link: HappyLink & { instanceId: string };
    as?: HappyShareLinkRole;
}

export interface HappyShareLinkFormatOptions {
    /** What the agent is. Only an agent link takes it. */
    as?: HappyShareLinkRole;
}

/** Everything before the payload. */
export const HAPPY_SHARE_URL_PREFIX = `${HAPPY_SHARE_LINK_ORIGIN}/#`;

const PAYLOAD_VERSION = "1";
const MAX_PAYLOAD_LENGTH = 4096;
const NUMBER = "[1-9][0-9]{0,8}";
const BODY = /^([a-z][a-z0-9]{23}\/[^?#]+)(?:\?([^#]*))?$/u;
const PARAMS = new Set(["as", "version", "lines"]);
const PARAM = /^([a-z]+)=([A-Za-z0-9\-._~%]+)$/u;
const NUMBER_ONLY = new RegExp(`^${NUMBER}$`, "u");
const LINES = new RegExp(`^(${NUMBER})(?:-(${NUMBER}))?$`, "u");
const FILE_LINES = new RegExp(`#L(${NUMBER})(?:-L(${NUMBER}))?$`, "u");

/**
 * What a share link carries, or undefined for anything that is not exactly one: another origin,
 * another payload version, a link without an instance, a parameter the link's kind does not take,
 * or any broken rule of the Happy URL it opens.
 */
export function parseHappyShareUrl(url: string): HappyShareLink | undefined {
    if (!url.startsWith(HAPPY_SHARE_URL_PREFIX)) return undefined;
    const payload = url.slice(HAPPY_SHARE_URL_PREFIX.length);
    if (payload.length > MAX_PAYLOAD_LENGTH || !payload.startsWith(`${PAYLOAD_VERSION}/`)) {
        return undefined;
    }
    const body = BODY.exec(payload.slice(PAYLOAD_VERSION.length + 1));
    if (body === null) return undefined;
    const [, rest = "", query] = body;
    const params = parseParams(query);
    if (params === undefined || [...params.keys()].some((key) => !PARAMS.has(key))) {
        return undefined;
    }

    let suffix = "";
    const version = params.get("version");
    if (version !== undefined) {
        if (!NUMBER_ONLY.test(version)) return undefined;
        suffix = `?version=${version}`;
    }
    const lines = params.get("lines");
    if (lines !== undefined) {
        const range = LINES.exec(lines);
        if (range === null) return undefined;
        suffix += `#L${range[1] ?? ""}${range[2] === undefined ? "" : `-L${range[2]}`}`;
    }
    const link = parseHappyUrl(`happy://${rest}${suffix}`);
    // A settings link has no share form. `version` and `lines` are refused by the Happy URL's
    // own grammar on any kind that does not take them.
    if (link?.instanceId === undefined || link.type === "settings") return undefined;

    const role = params.get("as");
    let as: HappyShareLinkRole | undefined;
    if (role !== undefined) {
        as = HAPPY_SHARE_LINK_ROLES.find((candidate) => candidate === role);
        if (as === undefined || link.type !== "reference" || link.reference.kind !== "agent") {
            return undefined;
        }
    }
    return {
        link: { ...link, instanceId: link.instanceId },
        ...(as === undefined ? {} : { as }),
    };
}

/**
 * The canonical share link for an instance link. Throws a `TypeError` for a link without an
 * `instanceId`, a settings link, a role on anything but an agent, or a link the grammar cannot
 * express.
 */
export function formatHappyShareUrl(
    link: HappyLink,
    options: HappyShareLinkFormatOptions = {},
): string {
    if (link.instanceId === undefined || link.type === "settings") {
        throw new TypeError("Only an instance link to an entity or a file has a share link.");
    }
    const { as } = options;
    if (
        as !== undefined &&
        (!HAPPY_SHARE_LINK_ROLES.includes(as) ||
            link.type !== "reference" ||
            link.reference.kind !== "agent")
    ) {
        throw new TypeError("Only an agent's share link says what the agent is.");
    }
    // `happy://<instanceId>/<rest>`, validated by the Happy URL's own formatter.
    let rest = formatHappyUrl(link).slice("happy://".length);
    const params: string[] = [];
    if (as !== undefined) params.push(`as=${as}`);
    const version = /\?version=([0-9]+)$/u.exec(rest);
    if (version !== null) {
        rest = rest.slice(0, version.index);
        params.push(`version=${version[1] ?? ""}`);
    }
    const lines = FILE_LINES.exec(rest);
    if (link.type === "file" && lines !== null) {
        rest = rest.slice(0, lines.index);
        params.push(`lines=${lines[1] ?? ""}${lines[2] === undefined ? "" : `-${lines[2]}`}`);
    }
    const payload = `${PAYLOAD_VERSION}/${rest}${params.length === 0 ? "" : `?${params.join("&")}`}`;
    if (payload.length > MAX_PAYLOAD_LENGTH)
        throw new TypeError("The Happy share link is too long.");
    return `${HAPPY_SHARE_URL_PREFIX}${payload}`;
}

/**
 * A ready-to-paste Markdown link, `[](https://link.happy.page/#1/…)`. Its label is always empty:
 * clients show the item's current name, so a written name would only go stale. A share link is
 * never written bare.
 */
export function formatHappyShareMarkdownLink(
    link: HappyLink,
    options: HappyShareLinkFormatOptions = {},
): string {
    return `[](${formatHappyShareUrl(link, options)})`;
}

/** Strict `key=value&…`: lowercase keys, each once, values non-empty and decoded. */
function parseParams(query: string | undefined): Map<string, string> | undefined {
    const params = new Map<string, string>();
    if (query === undefined) return params;
    for (const pair of query.split("&")) {
        const match = PARAM.exec(pair);
        if (match === null) return undefined;
        const [, key = "", encoded = ""] = match;
        let value: string;
        try {
            value = decodeURIComponent(encoded);
        } catch {
            return undefined;
        }
        if (value === "" || params.has(key)) return undefined;
        params.set(key, value);
    }
    return params;
}
