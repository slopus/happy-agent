import type { PermissionMode } from "../permissions/index.js";

/**
 * The one rule every way of searching is measured against.
 *
 * Rig offers several: a tool it executes itself through Claude, another through Gemini, and
 * searches Grok and OpenAI run on their own backends. They reach the same place — the network,
 * outside anything Rig sandboxes — so they answer to the same rule, stated once here.
 *
 * Where that rule is enforced is not the same for all of them, and must not be. A tool Rig
 * executes is judged when it is called, which is the moment Rig can still decline. A search the
 * provider runs is judged when the request is built, because that is the last moment there is:
 * by the time anything comes back, the search has happened on someone else's machine. One rule,
 * two honest places to apply it.
 */
export function permissionModeAllowsWebSearch(mode: PermissionMode | undefined): boolean {
    return mode === "auto" || mode === "full_access";
}

/**
 * The rule above, in the fields a tool definition declares.
 *
 * Spread into every tool Rig executes that reaches the open network — searching and fetching alike.
 * What they have in common is not that they search; it is where they end up, which is outside
 * everything Rig sandboxes. Written once so a third such tool cannot quietly answer differently.
 */
export const networkToolPermission = {
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
} as const;
