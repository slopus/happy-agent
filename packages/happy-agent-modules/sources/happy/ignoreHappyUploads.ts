import type { ProjectFileRoot, ProjectFilesModule } from "../files/index.js";
import { HAPPY_UPLOADS_DIRECTORY } from "./happyUploadPath.js";

/**
 * Keeps saved attachments out of Git: the uploads folder carries its own ignore file that ignores
 * everything in it, itself included, so the folder never shows as a change in any repository or
 * worktree, on this machine or a runner, without touching the project's ignore rules or Git's
 * control files. An ignore file already there is left exactly as it is.
 */
export async function ignoreHappyUploads(
    files: ProjectFilesModule,
    root: ProjectFileRoot,
): Promise<void> {
    await files
        .write(root, {
            content: Buffer.from("*\n").toString("base64"),
            expectedHash: null,
            path: `${HAPPY_UPLOADS_DIRECTORY}/.gitignore`,
        })
        .catch(() => undefined);
}
