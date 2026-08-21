/**
 * Path arithmetic in the machine's own terms.
 *
 * These deliberately do not use `node:path`. The paths belong to the compute, not to the process
 * holding these tools: an agent working inside a container names `/workspace/app` while the host
 * running Happy Agent may be a Windows machine, and `node:path` would answer with that host's separator
 * and its idea of what is absolute. So the rules are the machine's — a leading separator, or a
 * drive letter for a Windows compute — and everything else is ordinary segment arithmetic.
 */

/** The separator the machine uses, read from a path it already gave us. */
function separatorOf(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Whether the machine would read this path as absolute rather than relative to somewhere. */
function isAbsoluteComputePath(path: string): boolean {
    return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Drop `.` and `..` segments, keeping whatever root the path started from. */
function normalizeSegments(path: string, separator: string): string {
    const rootMatch = /^(\/|\\|[A-Za-z]:[\\/])/.exec(path);
    const root = rootMatch?.[0];
    const body = root === undefined ? path : path.slice(root.length);
    const segments: string[] = [];
    for (const segment of body.split(/[\\/]+/)) {
        if (segment === "" || segment === ".") continue;
        if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
            segments.pop();
            continue;
        }
        if (segment === ".." && root !== undefined) continue;
        segments.push(segment);
    }
    if (root === undefined) return segments.join(separator);
    const normalizedRoot = root === "/" || root === "\\" ? separator : root;
    return `${normalizedRoot}${segments.join(separator)}`;
}

/** Join a directory and a relative path the way the machine writes them. */
export function joinComputePath(directory: string, path: string): string {
    const separator = separatorOf(directory);
    return normalizeSegments(`${directory}${separator}${path}`, separator);
}

/**
 * The absolute path the machine means. `~` expands to its home directory when it has one, an
 * absolute path is kept as it was written, and anything else is relative to the working
 * directory.
 */
export function resolveComputePath(path: string, cwd: string, home?: string): string {
    if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
        if (home === undefined) {
            throw new Error("This machine has no home directory, so `~` cannot be resolved.");
        }
        return path === "~"
            ? normalizeSegments(home, separatorOf(home))
            : joinComputePath(home, path.slice(2));
    }
    return isAbsoluteComputePath(path)
        ? normalizeSegments(path, separatorOf(path))
        : joinComputePath(cwd, path);
}

/** The directory holding this path, or the path itself once there is nowhere left to go. */
export function parentComputePath(path: string): string {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (cut < 0) return path;
    const parent = path.slice(0, cut);
    return parent === "" ? path.slice(0, cut + 1) : parent;
}

/** The last segment of a path: the file's or directory's own name. */
export function basenameComputePath(path: string): string {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return cut < 0 ? path : path.slice(cut + 1);
}

/** Whether `path` is `directory` itself or something inside it. */
export function isPathInside(directory: string, path: string): boolean {
    if (path === directory) return true;
    const separator = separatorOf(directory);
    const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
    return path.startsWith(prefix);
}

/** What to call a path when talking about it relative to the directory a search started from. */
export function relativeComputePath(directory: string, path: string): string {
    if (!isPathInside(directory, path) || path === directory) return path;
    const separator = separatorOf(directory);
    const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
    return path.slice(prefix.length);
}
