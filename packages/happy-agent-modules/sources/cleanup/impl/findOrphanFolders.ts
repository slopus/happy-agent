import { dirname, join, resolve, sep } from "node:path";

import { computePermissions } from "@slopus/happy-agent-compute";

import type { ConfigModule } from "../../config/index.js";
import type { RunnersModule } from "../../runners/index.js";
import {
    MAX_CLEANUP_ORPHAN_FOLDERS,
    type CleanupFolderRootKind,
    type CleanupOrphanFolder,
    type CleanupOrphanFolders,
} from "../CleanupSearch.js";

/** Reading the product's own folders is the catalog's work, outside any agent's sandbox. */
const PRODUCT = computePermissions("full_access");

interface Root {
    readonly root: CleanupFolderRootKind;
    readonly folder: string;
    readonly runnerId?: string;
}

/**
 * The folders under this machine's Happy bot, task, workspace, and managed-project roots, and the
 * default runner's while runners are configured, that no record names and that hold no folder a
 * record names. A folder that holds a known one is looked into rather than reported, so a
 * project's workspace folder is reported on its own when the workspace is gone, and the project's
 * folder only when nothing in it is known. Surface folders belong to Surfaces and are not looked
 * through.
 */
export async function findOrphanFolders(
    config: ConfigModule,
    runners: RunnersModule,
    knownFolders: Iterable<string>,
): Promise<CleanupOrphanFolders> {
    const known = new Set([...knownFolders].map((folder) => resolve(folder)));
    const holdsKnown = (folder: string): boolean => {
        const prefix = folder.endsWith(sep) ? folder : `${folder}${sep}`;
        for (const path of known) if (path.startsWith(prefix)) return true;
        return false;
    };
    const machines: (string | undefined)[] = [undefined];
    if (runners.enabled && runners.defaultRunnerId !== undefined) {
        machines.push(runners.defaultRunnerId);
    }
    const orphans: CleanupOrphanFolder[] = [];
    const looked: CleanupOrphanFolders["roots"][number][] = [];
    let truncated = false;
    for (const runnerId of machines) {
        let roots: readonly Root[];
        try {
            roots = rootsOn(config, runners, runnerId);
        } catch (error: unknown) {
            looked.push({
                root: "bots",
                folder: "(unknown)",
                ...(runnerId === undefined ? {} : { runnerId }),
                error: describe(error),
            });
            continue;
        }
        for (const root of roots) {
            try {
                const machine = await runners.machine(runnerId);
                if (!(await machine.fs.exists(PRODUCT, root.folder))) {
                    looked.push(root);
                    continue;
                }
                const pending = [root.folder];
                while (pending.length > 0) {
                    const folder = pending.pop()!;
                    for (const name of [...(await machine.fs.readdir(PRODUCT, folder))].sort()) {
                        const child = join(folder, name);
                        const facts = await machine.fs.lstat(PRODUCT, child).catch(() => undefined);
                        if (facts?.isDirectory !== true || known.has(child)) continue;
                        if (holdsKnown(child)) {
                            pending.push(child);
                        } else if (orphans.length < MAX_CLEANUP_ORPHAN_FOLDERS) {
                            orphans.push({ ...root, folder: child });
                        } else {
                            truncated = true;
                        }
                    }
                }
                looked.push(root);
            } catch (error: unknown) {
                looked.push({ ...root, error: describe(error) });
            }
        }
    }
    return { orphans, roots: looked, truncated };
}

function rootsOn(
    config: ConfigModule,
    runners: RunnersModule,
    runnerId: string | undefined,
): readonly Root[] {
    const home = runners.machineHome(runnerId);
    const on = runnerId === undefined ? {} : { runnerId };
    if (home === undefined) {
        return [
            { root: "bots", folder: config.botsHome },
            { root: "tasks", folder: config.tasksHome },
            { root: "workspaces", folder: config.workspacesHome },
            { root: "projects", folder: config.projectsHome },
        ];
    }
    return [
        { root: "bots", folder: dirname(config.botPathOn(home.home, home.platform, "bot")), ...on },
        {
            root: "tasks",
            folder: dirname(config.taskPathOn(home.home, home.platform, "task")),
            ...on,
        },
        { root: "workspaces", folder: config.workspacesHomeOn(home.home, home.platform), ...on },
        { root: "projects", folder: config.projectsHomeOn(home.home), ...on },
    ];
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
