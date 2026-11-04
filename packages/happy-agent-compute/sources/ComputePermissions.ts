import { type Static, Type } from "@sinclair/typebox";

/**
 * How much of the machine one operation may touch.
 *
 * - `read_only` inspects and runs non-mutating commands; it changes nothing and reaches no
 *   network from a command.
 * - `workspace_write` changes anything inside the workspace, and still reaches no network.
 * - `auto` runs with the workspace-write boundary, and lets a single reviewed action run once
 *   with full access when that action's own policy requires it.
 * - `full_access` removes the filesystem, shell, and network restrictions entirely. It is all or
 *   nothing: it cannot be narrowed by a denial, and a permission value that tries is rejected.
 */
export const computePermissionModeSchema = Type.Union([
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("auto"),
    Type.Literal("full_access"),
]);

export type ComputePermissionMode = Static<typeof computePermissionModeSchema>;

/** The mode an operation runs under when the caller does not choose. */
export const DEFAULT_COMPUTE_PERMISSION_MODE: ComputePermissionMode = "auto";

/**
 * What a command may reach beyond the machine it runs on.
 *
 * Network access and the ability to accept an incoming connection are separate questions. A build
 * that fetches dependencies needs egress and no listener; a dev server needs a listener and often
 * no egress at all. Asking them separately means neither has to be granted to get the other.
 */
export const computeNetworkPermissionsSchema = Type.Object({
    /** Whether the command may open outbound connections at all. */
    egress: Type.Boolean(),
    /**
     * When egress is allowed, the hosts it is confined to. An empty list means anywhere; a
     * non-empty list is exhaustive, and everything absent from it is refused.
     */
    allowedHosts: Type.Optional(Type.Array(Type.String())),
    /**
     * Hosts refused even when `allowedHosts` names them, in the same syntax. Only narrows a
     * non-empty `allowedHosts`.
     */
    deniedHosts: Type.Optional(Type.Array(Type.String())),
    /**
     * The only destination ports the allowed hosts may be reached on. Absent means any port. Only
     * narrows a non-empty `allowedHosts`, and cannot be empty.
     */
    allowedPorts: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), { minItems: 1 }),
    ),
    /**
     * Whether the command may bind a local listening socket. This is off by default even where
     * egress is allowed, because a listener is reachable by things the agent did not start.
     */
    localBinding: Type.Boolean(),
});

export type ComputeNetworkPermissions = Static<typeof computeNetworkPermissionsSchema>;

/**
 * The boundary one operation runs inside.
 *
 * These permissions describe a single command, read, or write — not a machine and not a session.
 * The caller decides what an action is allowed to do and passes that decision in as the action is
 * performed, so a compute never holds an ambient policy that some other part of the program can
 * change underneath a call already in flight. A value is immutable: narrowing permissions means
 * making the next call with a narrower value, and it can never retroactively widen or narrow a
 * call that has already been made.
 *
 * `mode` is the coarse policy and the path lists refine it. A denial always beats a grant, so a
 * path in both `deniedWritePaths` and `allowedWritePaths` is refused.
 *
 * `full_access` is the exception, and it is absolute: it means every restriction is gone. It
 * therefore cannot be combined with a restriction, and a value that tries is rejected rather than
 * quietly resolved. See {@link assertComputePermissions}.
 */
export const computePermissionsSchema = Type.Object({
    mode: computePermissionModeSchema,
    /**
     * Directories readable beyond what the mode already permits, such as a skills library that
     * lives outside the workspace.
     */
    allowedReadPaths: Type.Optional(Type.Array(Type.String())),
    /**
     * Directories and files that must not be read even though the mode would otherwise permit it,
     * such as a credentials directory inside the workspace.
     */
    deniedReadPaths: Type.Optional(Type.Array(Type.String())),
    /**
     * Directories writable beyond the workspace, such as a build cache or an output directory the
     * person deliberately placed elsewhere.
     */
    allowedWritePaths: Type.Optional(Type.Array(Type.String())),
    /**
     * Paths that must not be written even inside the workspace, such as Git control files and the
     * project configuration that grants network access. This is the list a caller uses to protect
     * the very settings that decide what the agent may do.
     */
    deniedWritePaths: Type.Optional(Type.Array(Type.String())),
    network: computeNetworkPermissionsSchema,
});

export type ComputePermissions = Static<typeof computePermissionsSchema>;

/** Network permissions implied by a mode when the caller does not describe them. */
function defaultNetworkFor(mode: ComputePermissionMode): ComputeNetworkPermissions {
    return { egress: mode === "full_access", localBinding: mode === "full_access" };
}

/**
 * Refuses a permission value that says two different things at once.
 *
 * `full_access` means there is no boundary. A denial means there is one. A value carrying both is
 * not a narrow full access — it is a caller who believes they restricted something and a compute
 * that would ignore them, which is the worst possible outcome for a security boundary. The same
 * holds for withheld network access: `full_access` with `egress: false` reads as "unrestricted,
 * except restricted".
 *
 * So the contradiction is rejected at the boundary instead of being resolved. A caller who wants
 * most access with one exception is describing `auto` or `workspace_write` with grants, and the
 * error says so. Every backend calls this before acting on a permission value, so no backend has
 * to decide for itself which half of a contradiction to believe.
 */
export function assertComputePermissions(permissions: ComputePermissions): void {
    const { allowedHosts, allowedPorts, deniedHosts } = permissions.network;
    if (permissions.mode !== "full_access") {
        // An empty host list means any host, which no denial or port list can narrow.
        if ((deniedHosts?.length || allowedPorts !== undefined) && !allowedHosts?.length) {
            throw new Error(
                "Network deniedHosts and allowedPorts narrow allowedHosts, so they need a non-empty allowedHosts.",
            );
        }
        return;
    }
    const restrictions: string[] = [];
    if (permissions.deniedReadPaths?.length) restrictions.push("deniedReadPaths");
    if (permissions.deniedWritePaths?.length) restrictions.push("deniedWritePaths");
    if (allowedHosts?.length) restrictions.push("network.allowedHosts");
    if (deniedHosts?.length) restrictions.push("network.deniedHosts");
    if (allowedPorts !== undefined) restrictions.push("network.allowedPorts");
    if (!permissions.network.egress) restrictions.push("network.egress: false");
    if (!permissions.network.localBinding) restrictions.push("network.localBinding: false");
    if (restrictions.length === 0) return;
    throw new Error(
        `Full access cannot be combined with a restriction, but this permission sets ${restrictions.join(", ")}. ` +
            "Full access means every filesystem and network restriction is removed. To allow most things with an " +
            "exception, use auto or workspace_write and grant what that command needs.",
    );
}

/**
 * The permissions a mode means on its own.
 *
 * Most callers want exactly what a mode implies and nothing more, and spelling that out at every
 * call site is how the lists drift apart between backends. Pass overrides only for what genuinely
 * differs from the mode.
 *
 * A contradictory combination is refused here, at the point where it is written, rather than
 * surviving as a value that some later call has to interpret.
 */
export function computePermissions(
    mode: ComputePermissionMode = DEFAULT_COMPUTE_PERMISSION_MODE,
    overrides: Partial<Omit<ComputePermissions, "mode">> = {},
): ComputePermissions {
    const permissions: ComputePermissions = {
        mode,
        network: overrides.network ?? defaultNetworkFor(mode),
        ...(overrides.allowedReadPaths ? { allowedReadPaths: overrides.allowedReadPaths } : {}),
        ...(overrides.deniedReadPaths ? { deniedReadPaths: overrides.deniedReadPaths } : {}),
        ...(overrides.allowedWritePaths ? { allowedWritePaths: overrides.allowedWritePaths } : {}),
        ...(overrides.deniedWritePaths ? { deniedWritePaths: overrides.deniedWritePaths } : {}),
    };
    assertComputePermissions(permissions);
    return permissions;
}

/**
 * Everything allowed: no filesystem boundary, no network boundary, no listener restriction.
 *
 * This is the honest way to ask for unrestricted access, and it takes no options on purpose. There
 * is no such thing as full access with an exception, so there is nothing here to configure — a
 * caller that needs an exception wants {@link computePermissions} with `auto` or `workspace_write`.
 */
export function allowEverything(): ComputePermissions {
    return { mode: "full_access", network: { egress: true, localBinding: true } };
}
