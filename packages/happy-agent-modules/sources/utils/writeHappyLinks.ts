import {
    formatHappyMarkdownLink,
    formatHappyUrl,
    type HappyLink,
} from "@slopus/happy-agent-client";

import {
    formatHappyShareMarkdownLink,
    formatHappyShareUrl,
    HAPPY_SHARE_URL_PREFIX,
    type HappyShareLinkRole,
} from "./happyShareLinks.js";

/*
 * How the daemon writes Happy links for models and people: always a share link naming this
 * installation, with an empty label, `[](https://link.happy.page/#1/<instanceId>/…)`, so a link
 * works the same pasted into a browser, an email, or another app as it does in Happy. Clients show
 * the item's current name in place of the label, so a name written there would only go stale;
 * text for the model names the item in plain words beside the link.
 *
 * `instanceId` is the config module's `loadedInstanceId`. The runtime reads it before any module
 * starts, so it is undefined only where a module runs without the runtime, such as a unit test
 * with a stub config. The plain `happy://` link is written then: it has no form outside Happy, but
 * it still names the entity in every conversation of this installation, which is where those
 * callers' text is read.
 */

export interface HappyLinkWriteOptions {
    /** What an agent is. Only an agent link takes it. */
    as?: HappyShareLinkRole;
}

/** A ready-to-paste, empty-label Markdown link to an entity or file of this installation. */
export function writeHappyMarkdownLink(
    instanceId: string | undefined,
    link: HappyLink,
    options: HappyLinkWriteOptions = {},
): string {
    if (instanceId === undefined) return formatHappyMarkdownLink(link);
    return formatHappyShareMarkdownLink({ ...link, instanceId }, options);
}

/** The URL alone, for a field that holds one, such as a document's `link`. */
export function writeHappyUrl(
    instanceId: string | undefined,
    link: HappyLink,
    options: HappyLinkWriteOptions = {},
): string {
    if (instanceId === undefined) return formatHappyUrl(link);
    return formatHappyShareUrl({ ...link, instanceId }, options);
}

/** Which parameters a pattern carries; values may be placeholders such as `N`. */
export interface HappyUrlPatternOptions extends HappyLinkWriteOptions {
    /** An artifact version. */
    version?: string;
    /** A file's lines as `<start>-<end>` or `<line>`. */
    lines?: string;
}

/**
 * The URL an agent is told to write, for instructions, with placeholders in `rest`, the part after
 * the instance: `happyUrlPattern(id, "workspaces/<workspaceId>")` is
 * `https://link.happy.page/#1/<id>/workspaces/<workspaceId>`.
 */
export function happyUrlPattern(
    instanceId: string | undefined,
    rest: string,
    options: HappyUrlPatternOptions = {},
): string {
    if (instanceId === undefined) {
        const lines = options.lines === undefined ? "" : `#L${options.lines.replace("-", "-L")}`;
        const version = options.version === undefined ? "" : `?version=${options.version}`;
        return `happy://${rest}${version}${lines}`;
    }
    const params = [
        ...(options.as === undefined ? [] : [`as=${options.as}`]),
        ...(options.version === undefined ? [] : [`version=${options.version}`]),
        ...(options.lines === undefined ? [] : [`lines=${options.lines}`]),
    ];
    const query = params.length === 0 ? "" : `?${params.join("&")}`;
    return `${HAPPY_SHARE_URL_PREFIX}1/${instanceId}/${rest}${query}`;
}

/**
 * Whether a link someone wrote names this installation: a `happy://` link without an instance, or
 * an instance or share link naming this one. A link to another installation names nothing here.
 */
export function isHappyLinkHere(instanceId: string | undefined, link: HappyLink): boolean {
    return link.instanceId === undefined || link.instanceId === instanceId;
}
