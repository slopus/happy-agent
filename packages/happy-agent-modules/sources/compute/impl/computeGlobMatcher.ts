import { globToRegExp } from "./globToRegExp.js";
import { relativeComputePath, separatorOf } from "./resolveComputePath.js";

/**
 * Whether a path a search found under `root` matches a glob, whichever separator the machine
 * writes.
 *
 * A glob separates folders with `/`. A Windows machine writes its paths with `\`, which `*`
 * matched like any other character while a `/` in the pattern never matched it: `ideas/*.md`
 * found nothing there, and `*.md` reached into every folder. The path is now compared with `/`
 * between its folders. On a machine that writes `\`, a `\` in the pattern separates folders too:
 * no Windows name can contain one, and this dialect has no escape character to lose. Only the
 * comparison changes; the paths a search returns keep the machine's own separators.
 */
export function computeGlobMatcher(pattern: string, root: string): (path: string) => boolean {
    const backslashes = separatorOf(root) === "\\";
    const expression = globToRegExp(backslashes ? pattern.replaceAll("\\", "/") : pattern);
    return (path) => {
        const relative = relativeComputePath(root, path);
        return expression.test(backslashes ? relative.replaceAll("\\", "/") : relative);
    };
}
