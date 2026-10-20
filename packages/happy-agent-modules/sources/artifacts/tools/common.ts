import { Type, type Static } from "@sinclair/typebox";

import {
    artifactBackgroundInputSchema,
    artifactDisplaySchema,
    artifactPathSchema,
    artifactRecordSchema,
    artifactTitleSchema,
    artifactTypeSchema,
    MAX_ARTIFACT_FILES,
    type ArtifactRecord,
} from "../Artifact.js";

/** The one capability every artifact tool contributes to the model's instructions. */
export const ARTIFACT_TOOL_CAPABILITY =
    "Publish Markdown documents and HTML pages with their images and other files, images, image series, videos, and documents as versioned artifacts, and list, read, update, and delete them.";

/**
 * How a model mentions an artifact in a reply. Clients replace the tag with the artifact's live
 * title as a link, and surfaces that cannot show links get the title as plain text.
 */
export const ARTIFACT_REFERENCE_INSTRUCTIONS =
    'When you mention an artifact in a reply, write its reference tag inline, such as <happy-artifact id="…"/> with the artifact\'s ID; add version="N" to point at one version. The artifact tools give you the exact tag. People see the artifact\'s current title as a link in its place, so do not repeat the title beside the tag or link the artifact yourself. A tag inside code stays literal.';

/** How every writing tool describes `background`, which almost every artifact leaves out. */
const ARTIFACT_BACKGROUND_DESCRIPTION =
    'Usually leave this out: the artifact then sits on the viewer\'s own surface and follows light and dark. Set a hex colour such as "#ffffff" only when the content needs one fixed canvas, such as a print-like document or a chart drawn for one palette.';

/** How every writing tool describes `display`. */
const ARTIFACT_DISPLAY_DESCRIPTION =
    'How the chat shows an html artifact: "inline_expanded" draws it right in the conversation at its full height, "inline_compact" draws it there collapsed to its title until the reader expands it, and "side" shows its title, which opens it beside the chat. Leave it out to let the chat decide; other types are shown as a card.';

/** The colour behind a new artifact's content. */
export const artifactToolBackgroundSchema = Type.String({
    ...artifactBackgroundInputSchema,
    description: ARTIFACT_BACKGROUND_DESCRIPTION,
});

/** The colour behind a new version's content, or `null` to go back to a transparent slot. */
export const artifactToolBackgroundChangeSchema = Type.Union(
    [Type.String({ ...artifactBackgroundInputSchema }), Type.Null()],
    { description: `${ARTIFACT_BACKGROUND_DESCRIPTION} null removes it; leaving it out keeps it.` },
);

/** How a new artifact wants to be shown. */
export const artifactToolDisplaySchema = Type.Union(artifactDisplaySchema.anyOf, {
    description: ARTIFACT_DISPLAY_DESCRIPTION,
});

/** How a new version wants to be shown, or `null` to leave it to the chat. */
export const artifactToolDisplayChangeSchema = Type.Union(
    [...artifactDisplaySchema.anyOf, Type.Null()],
    { description: `${ARTIFACT_DISPLAY_DESCRIPTION} null removes it; leaving it out keeps it.` },
);

/** A file on the agent's machine copied into an artifact's next version. */
export const artifactToolSourceSchema = Type.Object(
    {
        fromPath: Type.String({
            minLength: 1,
            maxLength: 4096,
            description:
                "A file on your machine to copy in, such as an image you generated, a PDF, or a file you built with the shell",
        }),
        path: Type.Optional(
            Type.String({
                ...artifactPathSchema,
                description:
                    'Where the copy sits in the artifact, such as "images/chart.png", or "index.md" to make it a markdown artifact\'s entry. Defaults to the file\'s own name.',
            }),
        ),
    },
    { additionalProperties: false },
);

export const artifactToolSourcesSchema = Type.Array(artifactToolSourceSchema, {
    maxItems: MAX_ARTIFACT_FILES,
});

/** How an artifact's files work, as the tools that write them explain it. */
export const ARTIFACT_FILES_GUIDANCE = [
    "Write an artifact's files with write_artifact_file, which writes a whole text file, and edit_artifact_file, which replaces exact text in one, exactly as you would write and edit any other file: patch what changes instead of rewriting the whole page. Read them with read_artifact_file. These tools work directly on this installation's artifact catalog, so there is no copy on your machine: the shell cannot reach an artifact's files. To publish files you built with the shell or a script, or binary files such as images, pass them as fromPath files to create_artifact or update_artifact. Each call that writes an artifact makes its next version. You may change artifacts you created; changing one someone else made publishes a version everyone sees and needs the user's permission.",
    `A markdown artifact opens "index.md" and an html artifact opens "index.html"; put the pictures, styles, scripts, and other files they use beside them and refer to them with relative paths, such as ![Chart](images/chart.png) or <img src="img/hero.jpg">, which resolve without rewriting. A file's media type comes from its path's extension. An html page runs as it is, scripts included, in a sandbox that cannot reach this installation's data. If a call would leave the artifact invalid, such as without its entry or over a size limit, it fails, no version is made, and you are told why.`,
    'The display preference says where an html page is shown. "inline_expanded" draws it right in the reply at its full height, measured at the chat\'s width, and "inline_compact" draws it there collapsed to its title until the reader expands it; inline, nothing is ever capped or scrolls inside it. "side" shows its title in the chat, which opens it beside the chat, and suits a page that needs its own scrolling, a full window, or long reading. An inline page is part of the reply, so write it as that part of the reply would read: laid on the chat itself, with no frame, no background, no outer card or panel, nothing nested inside a box, and no fixed height or inner scrolling. Never use the default chatbot look: a stack of rounded cards, tinted callout boxes, or a highlighted coloured stripe down the left edge. Prefer clean visualizations, code examples and quotes, and file trees, and give hierarchy with spacing, hairline dividers, and type. DESIGN.md beside the Happy Agent documentation README is the full design system.',
    'Load Happy\'s standard styles first, with <link rel="stylesheet" href="/api/v1/style.css">: a transparent page in the chat\'s type and colours that follows light and dark, so leave html and body without a background or margin: it insets the page beside the chat and lines it up with the reply inline. Use its colour variables rather than fixed colours: --happy-text, --happy-muted, --happy-faint, --happy-border, --happy-surface, --happy-accent, --happy-added, --happy-removed, and --happy-chart-1 to --happy-chart-6. Load <script src="/api/v1/components.js"></script> last for the standard components: <happy-diff src="changes.diff"> shows a unified diff such as git diff writes (path="…" for one file, lines="40-52" for one range of it), and <happy-code src="src/app.ts"> shows code, from a file of the artifact or a <script type="text/plain"> child (language="ts" to name its language, path="…" for a header naming the file, lines="40-52" for one range of it), both drawn in Happy Desktop as it draws diffs and code, so prefer them to a <pre> of your own; <happy-files src="changes.diff"> shows the files a diff changes as a tree, or a <script type="application/json"> child listing [{"path","status","added","removed"}]; <happy-chart type="bar|hbar|line|area"> draws a chart from a <script type="application/json"> child of {"labels":[…],"series":[{"name","values":[…]}],"unit":"…"}; and <happy-diagram> draws a Mermaid flowchart, sequence, state, class, or ER diagram from a <script type="text/x-mermaid"> child. Anything else you draw yourself, such as an SVG in the --happy-* colours.',
    "Write a page in this order: its CSS first, then its HTML, then its JavaScript at the very end of the body, written to run only once the page is complete, so what is drawn arrives styled and never jumps.",
    'An html artifact can also be a live app, inline or beside the chat: <script src="/api/v1/client.js"></script> gives it a key-value store shared by all its versions and everyone using it, with realtime changes, writes that survive network failures, and who the viewer is. Before building one, read recipe/artifact-apps.md beside the Happy Agent documentation README. Call the API only at absolute /api/... paths, and put no files under api/. Read and change the data of an app yourself with read_artifact_data and write_artifact_data. Build and try the app in a folder of its own with happy-agent artifact dev as a workspace service, as two people and with network faults, then publish its files with fromPath in one update_artifact call, so people only ever see a finished version; after publishing, read_artifact_logs shows the errors and sync problems its pages reported.',
    'Types: "markdown" and "html" (the entry plus up to 255 other files; entry up to 4 MiB and 16 MiB), "image" (one PNG, JPEG, GIF, WebP, AVIF, or SVG up to 32 MiB), "image_series" (1–64 images shown in path order, so number them like 01-intro.png), "video" (one MP4, WebM, QuickTime, or Ogg up to 256 MiB), and "document" (one PDF, Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV, or EPUB file up to 64 MiB). A version holds at most 256 MiB in all.',
].join("\n\n");

/**
 * What a chat shows for an artifact a call made, changed, or took up, recorded with its result.
 * `shows` is `"latest"` where the chat follows the artifact as it changes, which is where an HTML
 * artifact is shown inline, and `"version"` where it records one change.
 */
const artifactToolPresentationSchema = Type.Object(
    {
        type: Type.Literal("artifact"),
        artifactId: artifactRecordSchema.properties.id,
        version: Type.Integer({ minimum: 1 }),
        artifactType: artifactTypeSchema,
        title: artifactTitleSchema,
        shows: Type.Union([Type.Literal("latest"), Type.Literal("version")]),
    },
    { additionalProperties: false },
);

/** What a writing tool returns: the artifact, and what the chat shows for it. */
export const artifactToolResultSchema = Type.Composite(
    [artifactRecordSchema, Type.Object({ presentation: artifactToolPresentationSchema })],
    { additionalProperties: false },
);

export type ArtifactToolResult = Static<typeof artifactToolResultSchema>;

/**
 * The artifact as a call left it, with what the chat shows for it: the artifact as it is now and
 * from then on (`"latest"`), or the version the call made (`"version"`).
 */
export function presentedArtifact(
    artifact: ArtifactRecord,
    shows: "latest" | "version",
): ArtifactToolResult {
    return {
        ...artifact,
        presentation: {
            type: "artifact",
            artifactId: artifact.id,
            version: artifact.latestVersion,
            artifactType: artifact.type,
            title: artifact.title,
            shows,
        },
    };
}

/** What a writing tool tells the model about what the user now sees. */
export const ARTIFACT_PRESENTED_NOTICE =
    "The user now sees it in this chat — an html artifact where its display preference puts it, inline at its full height, inline collapsed to its title, or as a title that opens it beside the chat, and anything else as a card that opens it — so do not describe it as if they cannot see it, and do not repeat what it shows. It appears only in this chat's history, not in any parent or child chat; if a user should see it in another chat, the agent in that chat must mention or present it there.";

/** What writing one artifact file returns: the artifact as the call left it, and what changed. */
export const artifactFileWriteResultSchema = Type.Composite(
    [
        artifactRecordSchema,
        Type.Object({
            path: artifactPathSchema,
            /** Whether the call made a version; writing a file exactly as it was makes none. */
            changed: Type.Boolean(),
            replacements: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
    ],
    { additionalProperties: false },
);
export type ArtifactFileWriteResult = Static<typeof artifactFileWriteResultSchema>;
