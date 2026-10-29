import { resolve, sep } from "node:path";

import type { CleanupFolderOwners, CleanupFolderRelation } from "../CleanupSearch.js";
import type { CleanupCatalog } from "./collectCleanupEntries.js";

/**
 * Every row and agent whose folder is the one asked about, holds it, or lies inside it, nearest
 * first: the folder itself, then what holds it, then what is inside it.
 */
export function findFolderOwners(
    catalog: CleanupCatalog,
    folder: string,
    now: number,
): CleanupFolderOwners {
    const asked = resolve(folder);
    const order: Record<CleanupFolderRelation, number> = { same: 0, contains: 1, inside: 2 };
    const items = catalog.entries.flatMap(({ item }) => {
        const relation = item.folder === undefined ? undefined : relate(item.folder, asked);
        return relation === undefined ? [] : [{ item, relation }];
    });
    items.sort((left, right) => order[left.relation] - order[right.relation]);
    const agents = [...catalog.agents.values()].flatMap((agent) => {
        const relation = agent.folder === undefined ? undefined : relate(agent.folder, asked);
        return relation === undefined ? [] : [{ agent, relation }];
    });
    agents.sort((left, right) => order[left.relation] - order[right.relation]);
    return { folder: asked, items, agents, at: now };
}

/** How `candidate` relates to `asked`, or undefined when neither holds the other. */
function relate(candidate: string, asked: string): CleanupFolderRelation | undefined {
    const resolved = resolve(candidate);
    if (resolved === asked) return "same";
    if (asked.startsWith(withSeparator(resolved))) return "contains";
    if (resolved.startsWith(withSeparator(asked))) return "inside";
    return undefined;
}

function withSeparator(path: string): string {
    return path.endsWith(sep) ? path : `${path}${sep}`;
}
