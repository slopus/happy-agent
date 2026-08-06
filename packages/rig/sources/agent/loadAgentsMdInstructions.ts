import { resolve } from "node:path";

import { AGENTS_MD_PROJECT_DOC_MAX_BYTES } from "./agentsMdProjectDocMaxBytes.js";
import type { FileSystemContext } from "./context/FileSystemContext.js";
import { findAgentsMdPaths } from "./findAgentsMdPaths.js";
import { formatAgentsMdInstructions } from "./formatAgentsMdInstructions.js";
import { formatAgentsSecurityInstructions } from "./formatAgentsSecurityInstructions.js";
import { formatGlobalAgentsMdInstructions } from "./formatGlobalAgentsMdInstructions.js";
import { isFileAtPath } from "./isFileAtPath.js";
import { readAgentsMdFile } from "./readAgentsMdFile.js";

export async function loadAgentsMdInstructions(
    fs: FileSystemContext,
    options: { globalInstructions?: string } = {},
): Promise<string | undefined> {
    const sections: string[] = [];

    // The user's own instructions lead, so the project's more specific files read as refinements
    // of them rather than the other way round.
    if (options.globalInstructions !== undefined && options.globalInstructions.trim().length > 0) {
        sections.push(formatGlobalAgentsMdInstructions(options.globalInstructions));
    }

    const securityPath = resolve(fs.cwd, "AGENTS_SECURITY.md");
    if (await isFileAtPath(fs, securityPath)) {
        const securityRules = await readAgentsMdFile(
            fs,
            securityPath,
            AGENTS_MD_PROJECT_DOC_MAX_BYTES,
        );
        if (securityRules !== undefined) {
            sections.push(formatAgentsSecurityInstructions(resolve(fs.cwd), securityRules));
        }
    }

    const paths = await findAgentsMdPaths(fs);
    let remaining = AGENTS_MD_PROJECT_DOC_MAX_BYTES;
    const docs: string[] = [];

    for (const path of paths) {
        const text = await readAgentsMdFile(fs, path, remaining);
        if (text === undefined) continue;

        docs.push(text);
        remaining -= Buffer.byteLength(text);
        if (remaining <= 0) break;
    }

    if (docs.length > 0) {
        sections.push(formatAgentsMdInstructions(resolve(fs.cwd), docs.join("\n\n")));
    }

    if (sections.length === 0) return undefined;
    return sections.join("\n\n");
}
