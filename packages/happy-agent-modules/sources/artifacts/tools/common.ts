import { Type } from "@sinclair/typebox";

import { artifactPathSchema, MAX_ARTIFACT_FILES } from "../Artifact.js";

/** The one capability every artifact tool contributes to the model's instructions. */
export const ARTIFACT_TOOL_CAPABILITY =
    "Publish Markdown documents and HTML pages with their images and other files, images, image series, videos, and documents as versioned artifacts, and list, read, update, and delete them.";

/** One file a call writes into an artifact. */
export const artifactToolFileSchema = Type.Object(
    {
        path: Type.Optional(
            Type.String({
                ...artifactPathSchema,
                description:
                    'Where the file sits in the artifact, such as "index.md" or "images/chart.png". Defaults to the type\'s entry for content and to the file\'s own name for fromPath.',
            }),
        ),
        content: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 16 * 1024 * 1024,
                description: "The file's whole text, such as Markdown, HTML, CSS, or a script",
            }),
        ),
        fromPath: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 4096,
                description:
                    "A file on your machine to copy in, such as an image you generated or a PDF",
            }),
        ),
    },
    { additionalProperties: false },
);

export const artifactToolFilesSchema = Type.Array(artifactToolFileSchema, {
    maxItems: MAX_ARTIFACT_FILES,
});

/** Where files go and how they relate, as every writing tool explains it. */
export const ARTIFACT_FILES_GUIDANCE = [
    "Every artifact version is a small tree of files. Each file has a path inside the artifact and comes either from content, its whole text, or from fromPath, a file on your machine such as an image you generated. A file's media type comes from its path's extension.",
    `A markdown artifact opens "index.md" and an html artifact opens "index.html"; put the pictures, styles, scripts, and other files they use beside them and refer to them with relative paths, such as ![Chart](images/chart.png) or <img src="img/hero.jpg">, which resolve without rewriting. An html page runs as it is, scripts included, in a sandbox that cannot reach this installation's data.`,
    'Types: "markdown" and "html" (the entry plus up to 255 other files; entry up to 4 MiB and 16 MiB), "image" (one PNG, JPEG, GIF, WebP, AVIF, or SVG up to 32 MiB), "image_series" (1–64 images shown in path order, so number them like 01-intro.png), "video" (one MP4, WebM, QuickTime, or Ogg up to 256 MiB), and "document" (one PDF, Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV, or EPUB file up to 64 MiB). A version holds at most 256 MiB in all.',
].join("\n\n");
