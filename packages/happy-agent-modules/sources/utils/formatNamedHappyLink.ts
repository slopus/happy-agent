import { formatHappyMarkdownLink, type HappyLink } from "@slopus/happy-agent-client";

/**
 * A ready-to-paste Markdown link to an entity, file, or settings page, `[name](happy://…)`, whose
 * link text is never empty. This is how every module writes a Happy link for a model or a person:
 * a link with nothing between the brackets shows as nothing wherever the reader does not fill in
 * the name itself, so one is never written. A blank `name` is replaced by `fallback`, and without
 * one by plain words for what the link names, such as "this artifact".
 */
export function formatNamedHappyLink(
    link: HappyLink,
    name: string | undefined,
    fallback?: string,
): string {
    const label = [name, fallback, describeHappyLink(link)]
        .map((candidate) => candidate?.trim() ?? "")
        .find((candidate) => candidate !== "");
    return formatHappyMarkdownLink(link, label);
}

/** Plain words for what a link names, used only when nobody supplied its name. */
function describeHappyLink(link: HappyLink): string {
    switch (link.type) {
        case "reference":
            return `this ${link.reference.kind}`;
        case "file":
            return link.file.path.split("/").findLast((segment) => segment !== "") ?? "this file";
        case "settings":
            return "Settings";
    }
}
