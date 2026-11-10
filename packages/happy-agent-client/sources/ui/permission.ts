import { Type, type Static } from "@sinclair/typebox";

/**
 * The permission registry chat UI actions declare against. The IDs are Happy Cloud's
 * (`hc_store::roles`). Each server answers whether the clicking person holds one its own way:
 *
 * - a standalone daemon: its one user holds every permission;
 * - daemon team mode: the owner holds every permission, members hold {@link UI_MEMBER_PERMISSIONS};
 * - Happy Cloud: the member's role.
 */
export const UI_PERMISSION_IDS = [
    "content.write",
    "providers.manage",
    "providers.own",
    "config.manage",
] as const;

export const uiPermissionIdSchema = Type.Union(UI_PERMISSION_IDS.map((id) => Type.Literal(id)));
export type UiPermissionId = (typeof UI_PERMISSION_IDS)[number];

/** What a member who is not the owner holds on a daemon in team mode. */
export const UI_MEMBER_PERMISSIONS: readonly UiPermissionId[] = ["content.write", "providers.own"];

/**
 * What an action needs, declared on its bundle: one permission ID. An action that declares nothing
 * needs `content.write`: it may send in this conversation.
 *
 * This is the only form today. A form that depends on the offer joins this schema as another
 * member of a union, and {@link uiActionPermission} is the one place that resolves it.
 */
export const uiPermissionSchema = uiPermissionIdSchema;
export type UiPermission = Static<typeof uiPermissionSchema>;

/**
 * The permission an action needs against an offer's stored props. Every server and client uses
 * this same function. The props choose nothing yet; they are taken so that a permission which
 * depends on the offer changes no caller.
 */
export function uiActionPermission(
    action: { readonly permission?: UiPermission },
    _props: unknown,
): UiPermissionId {
    return action.permission ?? "content.write";
}

/**
 * Whether a person holding `granted` may send an action against an offer's props. Clients use it
 * only to disable what the viewer cannot do; the server decides.
 */
export function uiActionAllowed(
    action: { readonly permission?: UiPermission },
    props: unknown,
    granted: ReadonlySet<string> | readonly string[],
): boolean {
    const needed = uiActionPermission(action, props);
    return Array.isArray(granted)
        ? granted.includes(needed)
        : (granted as ReadonlySet<string>).has(needed);
}
