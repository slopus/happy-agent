import { readFile } from "node:fs/promises";

import {
    describeGenUiErrors,
    genUiRenderLimitErrors,
    validateGenUiDocument,
    type GenUiDocument,
} from "../../impl/genUi/validateGenUiDocument.js";
import { compileGenUi, genUiImageSources, type GenUiImage } from "../../impl/genUi/compileGenUi.js";
import {
    ArtifactInputError,
    type ArtifactFile,
    type ArtifactRecord,
    type ArtifactType,
} from "../Artifact.js";
import { ARTIFACT_PICTURE_FORMATS } from "./measureArtifactMedia.js";
import { MAX_ARTIFACT_SUMMARY_CHARACTERS } from "./normalizeArtifactSummary.js";

/**
 * Read a gen_ui artifact's entry and refuse it, with the validator's reasons, unless it is a
 * valid Gen UI document.
 */
export async function readGenUiEntry(contentPath: string, path: string): Promise<GenUiDocument> {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(contentPath));
    } catch {
        throw new ArtifactInputError(`"${path}" must be UTF-8 text.`);
    }
    const validation = validateGenUiDocument(text);
    if (!validation.ok) {
        throw new ArtifactInputError(describeGenUiErrors(path, validation.errors));
    }
    return validation.document;
}

/**
 * The summary a gen_ui version shows when nobody wrote one: its document's fallback, as plain
 * text within a summary's limits, or none when the fallback is empty.
 */
export function genUiFallbackSummary(document: GenUiDocument): string | undefined {
    const text = (document.fallback ?? "")
        .replaceAll("\r\n", "\n")
        .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
        .trim();
    if (text === "") return undefined;
    const characters = [...text];
    return characters.length > MAX_ARTIFACT_SUMMARY_CHARACTERS
        ? characters.slice(0, MAX_ARTIFACT_SUMMARY_CHARACTERS).join("").trimEnd()
        : text;
}

/**
 * Where a gen_ui version keeps what the daemon derives from its document. Clients read the render
 * document there; the model never sees these files and cannot write them.
 */
export const GEN_UI_DERIVED_FOLDER = ".genui";
export const GEN_UI_RENDER_PATH = `${GEN_UI_DERIVED_FOLDER}/render.json`;

/** Whether a path of an artifact of this type is derived data, hidden from the model. */
export function isGenUiDerivedPath(type: ArtifactType, path: string): boolean {
    return (
        type === "gen_ui" &&
        (path === GEN_UI_DERIVED_FOLDER || path.startsWith(`${GEN_UI_DERIVED_FOLDER}/`))
    );
}

/** The files of a version the model sees: all of them but derived data. */
export function modelArtifactFiles<File extends { readonly path: string }>(
    type: ArtifactType,
    files: readonly File[],
): File[] {
    return files.filter((file) => !isGenUiDerivedPath(type, file.path));
}

/** How many files of a version the model sees. */
export function modelArtifactFileCount(artifact: ArtifactRecord): number {
    // Every gen_ui version holds exactly one derived file, its render document.
    return artifact.type === "gen_ui" ? artifact.fileCount - 1 : artifact.fileCount;
}

/**
 * The render document of a valid authoring document whose images are `files` of the same
 * version, as stored text. Refuses, naming each element and prop path, an image that is not a
 * measured picture of the version: remote images are not fetched, so every `src` must be a path
 * relative to the document.
 */
export function compileGenUiEntry(
    document: GenUiDocument,
    files: readonly ArtifactFile[],
    entryPath: string,
): string {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const images = new Map<string, GenUiImage>();
    const errors: string[] = [];
    for (const source of genUiImageSources(document)) {
        if (images.has(source.src)) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(source.src)) {
            errors.push(
                `${source.path}: ${JSON.stringify(source.src)} is a remote image, and remote images are not fetched; add the picture as a file of the artifact, such as "assets/photo.jpg", and use that path`,
            );
            continue;
        }
        const path = source.src.replace(/^(?:\.\/)+/, "");
        const file = isGenUiDerivedPath("gen_ui", path) ? undefined : byPath.get(path);
        if (file === undefined) {
            errors.push(`${source.path}: the artifact has no file ${JSON.stringify(path)}`);
            continue;
        }
        if (
            ARTIFACT_PICTURE_FORMATS[file.mimeType] === undefined ||
            file.width === undefined ||
            file.height === undefined ||
            file.thumbhash === undefined
        ) {
            errors.push(
                `${source.path}: ${JSON.stringify(path)} is not a PNG, JPEG, WebP, GIF, or AVIF picture that could be decoded`,
            );
            continue;
        }
        images.set(source.src, {
            file: file.path,
            width: file.width,
            height: file.height,
            thumbhash: file.thumbhash,
        });
    }
    if (errors.length > 0) {
        throw new ArtifactInputError(describeGenUiErrors(entryPath, errors));
    }
    const render = compileGenUi(document, images);
    const over = genUiRenderLimitErrors(render);
    if (over.length > 0) throw new ArtifactInputError(describeGenUiErrors(entryPath, over));
    return `${JSON.stringify(render)}\n`;
}
