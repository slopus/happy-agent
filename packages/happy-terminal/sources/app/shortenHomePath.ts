import { homedir } from "node:os";

/** Displays a path the way a shell prompt would, with the home directory written as `~`. */
export function shortenHomePath(path: string): string {
    const home = homedir();
    if (home.length > 0 && (path === home || path.startsWith(`${home}/`))) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}
