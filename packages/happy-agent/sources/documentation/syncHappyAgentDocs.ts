import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
    syncHappyAgentDocumentation,
    type HappyAgentDocumentationFile,
} from "./syncHappyAgentDocumentation.js";

/** Synchronize the documentation shipped beside this package into the configured Happy home. */
export async function syncHappyAgentDocs(
    happyHome: string,
    sourceDirectory?: string,
): Promise<void> {
    const source = sourceDirectory ?? (await resolvePackagedDocumentation());
    await syncHappyAgentDocumentation(happyHome, await readDocumentation(source));
}

async function resolvePackagedDocumentation(): Promise<string> {
    const candidates = [
        join(import.meta.dirname, "..", "docs"),
        join(import.meta.dirname, "..", "..", "..", "..", "docs"),
    ];
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the source-tree location after the packaged distribution location.
        }
    }
    throw new Error("The packaged Happy Agent documentation is missing.");
}

async function readDocumentation(
    sourceDirectory: string,
): Promise<readonly HappyAgentDocumentationFile[]> {
    const files: HappyAgentDocumentationFile[] = [];
    await visit(sourceDirectory);
    return files;

    async function visit(directory: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(path);
            } else if (entry.isFile()) {
                files.push({
                    contents: await readFile(path),
                    relativePath: relative(sourceDirectory, path),
                });
            } else {
                throw new Error(
                    `Packaged Happy Agent documentation contains an unsafe entry: ${path}`,
                );
            }
        }
    }
}
