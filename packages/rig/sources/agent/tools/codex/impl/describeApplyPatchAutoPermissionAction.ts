import type { AgentContext } from "../../../context/AgentContext.js";
import { resolveFileSystemPath } from "../../../context/resolveFileSystemPath.js";
import { parsePatchPathDirective } from "../../../../patch/parsePatchPathDirective.js";
import { quoteVisibleExact } from "../../../../permissions/quoteVisibleExact.js";
import { isProtectedPath } from "../../../../permissions/isProtectedPath.js";

export function describeApplyPatchAutoPermissionAction(
    args: { patch: string; workdir?: string },
    context: AgentContext,
): string {
    let workdir = args.workdir ?? context.fs.cwd;
    try {
        workdir = resolveFileSystemPath(workdir, context.fs.cwd, context.fs.home);
    } catch {
        // Preserve the supplied value so a malformed path remains visible in the reviewed action.
    }

    const paths = new Set<string>();
    for (const line of args.patch.replace(/\r\n/g, "\n").split("\n")) {
        const directive = parsePatchPathDirective(line);
        if (directive === undefined) continue;
        try {
            paths.add(resolveFileSystemPath(directive.path, workdir, context.fs.home));
        } catch {
            paths.add(directive.path);
        }
    }
    const affectedPaths =
        paths.size === 0
            ? "not available from the patch"
            : [...paths].map(quoteVisibleExact).join(", ");
    const access = [...paths].some((path) =>
        isProtectedPath(path, context.permissions?.protectedPaths ?? []),
    )
        ? "protected workspace path requiring Full access"
        : "unrestricted filesystem access outside the workspace sandbox";

    return `applying a patch. Affected paths: ${affectedPaths}. Working directory: ${quoteVisibleExact(workdir)}. Access: ${access}`;
}
