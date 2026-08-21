/**
 * Assembles the user's security policy for one review, ported from Happy Agent v1's
 * `createCodingAssistantAgent.ts` reviewer `readSecurityPolicy`. The global `SECURITY.md` and the
 * project-root `AGENTS_SECURITY.md` are read again before every review, so an edit made while a
 * session is open takes effect on the next review without restarting anything.
 *
 * Each file is bounded to 32 KiB and dropped when blank, matching v1's `readGlobalSecurityMd` and
 * `readProjectSecurityMd`. Where those files are, and what an absent one means, belongs to the
 * configuration module that owns the layout: a missing file, or a path that turns out not to be a
 * readable file, resolves to nothing, and any other read error propagates so the caller can make
 * the review unavailable rather than review against a partial policy. The two present files are
 * joined here under the exact v1 headings, and the combined text becomes the "user security policy"
 * section the guardian prompt appends after its built-in policy.
 */

/** Keeps each configured security file within a predictable prompt budget, as in v1. */
export const AUTO_SECURITY_MD_MAX_BYTES = 32 * 1024;

export const GLOBAL_SECURITY_HEADING = "## Global SECURITY.md";
export const PROJECT_SECURITY_HEADING = "## Project AGENTS_SECURITY.md";

export async function readAutoSecurityPolicy(readers: {
    /** Reads and bounds the global `SECURITY.md`, or resolves `undefined` when it is absent. */
    readGlobalSecurity: () => Promise<string | undefined>;
    /** Reads and bounds the project-root `AGENTS_SECURITY.md`, or `undefined` when absent. */
    readProjectSecurity: () => Promise<string | undefined>;
}): Promise<string | undefined> {
    const [globalPolicy, projectPolicy] = await Promise.all([
        readers.readGlobalSecurity(),
        readers.readProjectSecurity(),
    ]);
    const policies = [
        ...(globalPolicy === undefined ? [] : [`${GLOBAL_SECURITY_HEADING}\n\n${globalPolicy}`]),
        ...(projectPolicy === undefined ? [] : [`${PROJECT_SECURITY_HEADING}\n\n${projectPolicy}`]),
    ];
    return policies.length === 0 ? undefined : policies.join("\n\n");
}
