import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Whether `root` is the user's home directory or one of its ancestors.
 *
 * Such a tree holds other applications' data. On macOS the native watcher stats every changed
 * path it reports, and a stat inside `~/Library/Containers`, the Photos library, Contacts or
 * Documents asks the user to grant the app access to that data, again and again while those
 * applications write. On Linux it would spend an inotify watch on every directory in the home.
 */
export async function containsHomeDirectory(root: string): Promise<boolean> {
    const [canonicalRoot, home] = await Promise.all([
        realpath(root).catch(() => resolve(root)),
        realpath(homedir()).catch(() => resolve(homedir())),
    ]);
    const path = relative(canonicalRoot, home);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
