import { resolveComputePath } from "../../../impl/resolveComputePath.js";
import { parseCodexPatchDirective } from "../../../../impl/parseCodexPatch.js";

/**
 * Every file a patch names, as absolute paths on the machine.
 *
 * This reads only the directive lines, so it answers for a patch that will later turn out to be
 * malformed as well as one that applies. That is what a reviewer needs: the question is which
 * files are about to be touched, and a patch nobody can parse is not a patch that touches
 * nothing. A path the machine cannot resolve is kept exactly as the model wrote it, because the
 * proposal is what is being judged.
 */
export function codexPatchPaths(
    patch: string,
    workdir: string,
    home: string | undefined,
): readonly string[] {
    const paths = new Set<string>();
    for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
        const directive = parseCodexPatchDirective(line);
        if (directive === undefined) continue;
        try {
            paths.add(resolveComputePath(directive.path, workdir, home));
        } catch {
            paths.add(directive.path);
        }
    }
    return [...paths];
}
