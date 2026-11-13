import { Type, type Static } from "@sinclair/typebox";

import {
    artifactBackgroundInputSchema,
    artifactDisplaySchema,
    artifactPathSchema,
    artifactRecordSchema,
    artifactSummaryInputSchema,
    artifactTitleSchema,
    artifactTypeSchema,
    MAX_ARTIFACT_FILES,
    type ArtifactRecord,
} from "../Artifact.js";

/** The one capability every artifact tool contributes to the model's instructions. */
export const ARTIFACT_TOOL_CAPABILITY =
    "Publish Markdown documents, HTML pages, and Gen UI documents with their images and other files, images, image series, videos, and documents as versioned artifacts, and list, read, update, and delete them.";

/**
 * How a model mentions an artifact in a reply. Clients show the link with the artifact's live
 * title, and surfaces that cannot show links get the title as plain text.
 */
export const ARTIFACT_REFERENCE_INSTRUCTIONS =
    "When you mention an artifact in a reply, link it as [its title](happy://artifacts/<artifactId>); add ?version=N to point at one version. The artifact tools give you the exact link. People see the artifact's current title as the link text, so do not repeat the title beside the link. A link inside code stays literal.";

/**
 * What makes a good artifact in the Feed, as every agent's instructions say it: the artifact tools
 * are deferred, so an agent may plan an artifact before it has read their descriptions.
 */
export const ARTIFACT_COVER_INSTRUCTIONS =
    "A good artifact has a cover: a WebP, still or animated, either 16:9 (1600×900) or square (1200×1200), showing its headline, key number, or main chart, readable at feed size; the Feed shows it full width. Give one, with a summary, a short post saying what it is and the key takeaway, to any report, analysis, or result people would want to see in the Feed: render it first with what you have, such as a headless browser screenshot, rsvg-convert, or matplotlib, then name that file as cover in create_artifact or update_artifact. Scratch and utility artifacts may go without.";

/** How every writing tool describes `cover`. */
const ARTIFACT_COVER_DESCRIPTION =
    "The path of the artifact's cover image among its files, such as \"cover.webp\": a WebP, still or animated, showing the headline, key number, or main chart, readable at feed size. A cover is either 16:9 (1600×900) or square (1200×1200); other shapes are refused. PNG and JPEG work too; convert a GIF to animated WebP first, and SVG is refused. An image artifact's cover is its own picture and an image series' its first, unless you name another or pass null.";

/** How every writing tool describes `summary`. */
const ARTIFACT_SUMMARY_DESCRIPTION =
    "A short post shown under the title, like a tweet: what this is and the key takeaway, in a few sentences of plain text. Line breaks are fine; no Markdown. At most 5,000 characters.";

/** A new artifact's cover, or `null` for none. */
export const artifactToolCoverSchema = Type.Union(
    [Type.String({ ...artifactPathSchema }), Type.Null()],
    { description: ARTIFACT_COVER_DESCRIPTION },
);

/** A new version's cover, or `null` to remove it. */
export const artifactToolCoverChangeSchema = Type.Union(
    [Type.String({ ...artifactPathSchema }), Type.Null()],
    {
        description: `${ARTIFACT_COVER_DESCRIPTION} null removes it; leaving it out keeps it, and its file must then stay in the artifact.`,
    },
);

/** A new artifact's summary. */
export const artifactToolSummarySchema = Type.String({
    ...artifactSummaryInputSchema,
    description: ARTIFACT_SUMMARY_DESCRIPTION,
});

/** A new version's summary, or `null` to remove it. */
export const artifactToolSummaryChangeSchema = Type.Union(
    [Type.String({ ...artifactSummaryInputSchema }), Type.Null()],
    { description: `${ARTIFACT_SUMMARY_DESCRIPTION} null removes it; leaving it out keeps it.` },
);

/** How the writing tools explain covers. */
export const ARTIFACT_COVER_GUIDANCE =
    "A good artifact has a cover and a summary. The summary is a short post under the title: what this is and the key takeaway, in a few sentences of plain text, line breaks fine, no Markdown. The cover is a WebP, either 16:9 (1600×900) or square (1200×1200), showing the headline, key number, or main chart, readable at feed size; the Feed shows it full width and draws nothing over it. Add one to any report, analysis, or result people would want to see in the Feed; scratch and utility artifacts may go without. For a chart or diagram, render it first with what you have, such as a headless browser screenshot, rsvg-convert, or matplotlib, and save it as WebP. A short looping animated WebP is fine; keep it small, and convert a GIF to one first: ffmpeg -i in.gif -c:v libwebp -loop 0 -q:v 75 cover.webp. PNG and JPEG are accepted; GIF is accepted but discouraged; SVG is refused.";

/** How every writing tool describes `background`, which almost every artifact leaves out. */
const ARTIFACT_BACKGROUND_DESCRIPTION =
    'Usually leave this out: the artifact then sits on the viewer\'s own surface and follows light and dark. Set a hex colour such as "#ffffff" only when the content needs one fixed canvas, such as a print-like document or a chart drawn for one palette.';

/** How every writing tool describes `display`. */
const ARTIFACT_DISPLAY_DESCRIPTION =
    'How the chat first shows the artifact: "inline_expanded" starts open in the conversation, and "inline_compact" and "side" start collapsed to its title, which the reader can expand. Left out, html, gen_ui, image, image_series, and video artifacts start open and markdown starts collapsed.';

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
    'An open html page is drawn right in the reply at its full height, measured at the chat\'s width; inline, the page is never capped and never scrolls as a whole. "side" suits a page that needs its own scrolling, a full window, or long reading. An inline page is part of the reply, so write it as that part of the reply would read: laid on the chat itself, with no frame, no background, no outer card or panel, and nothing nested inside a box. Its first render decides its height, and the reply around it shifts whenever that changes, so design every state to fit it: size tabs to the tallest panel by stacking the panels in one grid cell, show details in a popover rather than an accordion that pushes content down, keep a long or changing list or log in one scrolling region of fixed height, and reserve room for data still loading, images (width and height, or aspect-ratio), and empty and error states. Never reach that height with padding: no large fixed or minimum heights that leave blank space, and nothing sized to the viewport, such as 100vh, because the frame grows to fit the page. If one state needs far less room than another, such as a short tab beside a long one, redesign so they match, by giving it useful content or showing both together; if you cannot, let the page shrink rather than leave an empty gap. Never use the default chatbot look: a stack of rounded cards, tinted callout boxes, or a highlighted coloured stripe down the left edge. Prefer clean visualizations, code examples and quotes, and file trees, and give hierarchy with spacing, hairline dividers, and type. DESIGN.md beside the Happy Agent documentation README is the full design system.',
    'Load Happy\'s standard styles first, with <link rel="stylesheet" href="/api/v1/style.css">: with nothing else, the page looks like part of the app, in its fonts, colours, scrollbars, and inset, in light and dark, so leave html and body without a background, margin, or padding: the page is inset like the app\'s content beside the chat or on its own, and not at all inline, where it lines up with the reply. Beside the chat and on its own, Happy Desktop also centres the page in Happy\'s 912px content column, so never centre or cap it yourself with max-width and margin: auto on body; narrower content is fine. A dashboard, wide table, canvas, or other full-width app opts out with <meta name="happy-page-width" content="full"> in <head>, and only such a page may use width: 100vw. A game, canvas, drawing pad, or other single-screen app that page scrolling would fight, but never a document or dashboard meant to be read, opts into app mode with <meta name="happy-page-mode" content="app"> in <head>: the host opens it full screen from a card, edge to edge with no scrolling or zoom, and owns its close control, a "×" in the top-start corner whose 48px the inset on that edge already holds; fill the viewport with height: 100%, handle resize and rotation, keep controls clear of env(safe-area-inset-*) and --happy-app-inset-*, and take touch, mouse, and keyboard. If the game needs that corner, move the "×" with <meta name="happy-app-close" content="top-end"> (or bottom-start or bottom-end); an exit the page draws, such as Quit in a pause menu, calls window.happyApp.close(), and content="none", which hides the "×", is only for a page whose own exit is always clearly visible. Your own CSS always wins, so override only on purpose. Use its variables rather than fixed colours: --happy-text, --happy-muted, --happy-faint, --happy-border, --happy-surface, --happy-accent, --happy-added, --happy-removed, and --happy-chart-1 to --happy-chart-6, with --happy-font and --happy-mono for type. Load <script src="/api/v1/components.js"></script> last for the standard components: <happy-diff src="changes.diff"> shows a unified diff such as git diff writes (path="…" for one file, lines="40-52" for one range of it), and <happy-code src="src/app.ts"> shows code, from a file of the artifact or a <script type="text/plain"> child (language="ts" to name its language, path="…" for a header naming the file, lines="40-52" for one range of it), both drawn in Happy Desktop as it draws diffs and code, so prefer them to a <pre> of your own; <happy-files src="changes.diff"> shows the files a diff changes as a tree, or a <script type="application/json"> child listing [{"path","status","added","removed"}]; <happy-chart type="bar|hbar|line|area"> draws a chart from a <script type="application/json"> child of {"labels":[…],"series":[{"name","values":[…]}],"unit":"…"}; and <happy-diagram> draws a Mermaid flowchart, sequence, state, class, or ER diagram from a <script type="text/x-mermaid"> child. Anything else you draw yourself, such as an SVG in the --happy-* colours.',
    "Write a page in this order: its CSS first, then its HTML, then its JavaScript at the very end of the body, written to run only once the page is complete, so what is drawn arrives styled and never jumps.",
    'An html artifact can also be a live app, inline or beside the chat: <script src="/api/v1/client.js"></script> gives it a key-value store shared by all its versions and everyone using it, with realtime changes, writes that survive network failures, and who the viewer is. Before building one, read recipe/artifact-apps.md beside the Happy Agent documentation README. Call the API only at absolute /api/... paths, and put no files under api/. Read and change the data of an app yourself with read_artifact_data and write_artifact_data. Build and try the app in a folder of its own with happy-agent artifact dev as a workspace service, as two people and with network faults, then publish its files with fromPath in one update_artifact call, so people only ever see a finished version; after publishing, read_artifact_logs shows the errors and sync problems its pages reported.',
    'Types: "markdown" and "html" (the entry plus up to 255 other files; entry up to 4 MiB and 16 MiB), "image" (one PNG, JPEG, GIF, WebP, AVIF, or SVG up to 32 MiB), "image_series" (1–64 images shown in path order, so number them like 01-intro.png), "video" (one MP4, WebM, QuickTime, or Ogg up to 256 MiB), "document" (one PDF, Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV, or EPUB file up to 64 MiB), and "gen_ui" (a Gen UI document, "index.genui.json" up to 256 KiB, plus up to 255 other files such as the images it shows). A version holds at most 256 MiB in all.',
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
