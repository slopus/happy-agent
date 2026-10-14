import type { GitBranch, GitBranchList } from "./listGitBranches.js";

/**
 * The branches a person typing `query` most likely means, at most `limit` of them.
 *
 * Matching is a case-insensitive substring. A branch whose name, with or without its remote,
 * starts with the query comes first, so `fern` puts `origin/FERN-1234` ahead of `fix-fern`. Within
 * each group the newest commit leads, then local before remote, then the name, so the order never
 * depends on Git's. An empty query lists the newest branches.
 */
export function selectGitBranches(
    list: GitBranchList,
    query: string,
    limit: number,
): GitBranchList {
    const wanted = query.toLowerCase();
    const matches: { branch: GitBranch; prefix: boolean }[] = [];
    for (const branch of list.branches) {
        const name = branch.ref.toLowerCase();
        if (!name.includes(wanted)) continue;
        // A remote-tracking ref is `<remote>/<branch>`; the listing reads no remote names, and a
        // remote name with a slash in it is too rare to spend a second Git process on.
        const prefix =
            name.startsWith(wanted) ||
            (branch.remote && name.slice(name.indexOf("/") + 1).startsWith(wanted));
        matches.push({ branch, prefix });
    }
    matches.sort(
        (left, right) =>
            Number(right.prefix) - Number(left.prefix) ||
            (right.branch.committedAt ?? -1) - (left.branch.committedAt ?? -1) ||
            Number(left.branch.remote) - Number(right.branch.remote) ||
            (left.branch.ref < right.branch.ref ? -1 : left.branch.ref > right.branch.ref ? 1 : 0),
    );
    return {
        branches: matches.slice(0, limit).map(({ branch }) => branch),
        truncated: list.truncated || matches.length > limit,
    };
}
