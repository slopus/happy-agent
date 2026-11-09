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
    "members.manage",
    "pools.manage",
    "repositories.manage",
] as const;

export const uiPermissionIdSchema = Type.Union(UI_PERMISSION_IDS.map((id) => Type.Literal(id)));
export type UiPermissionId = (typeof UI_PERMISSION_IDS)[number];

/** What a member who is not the owner holds on a daemon in team mode. */
export const UI_MEMBER_PERMISSIONS: readonly UiPermissionId[] = ["content.write", "providers.own"];

/**
 * What an action needs, declared on its bundle:
 *
 * - a permission ID;
 * - a permission chosen by one prop of the offer, with a default when the prop is absent or not in
 *   the map, as `provider_sign_in`'s `target` does;
 * - `{ conversation: "read" }`: only that the person can read the conversation, for actions that
 *   make the caller's own credential, such as `github_connect.device_start`.
 *
 * An action that declares nothing needs `content.write`: it may send in this conversation.
 */
export const uiPermissionSchema = Type.Union([
    uiPermissionIdSchema,
    Type.Object(
        {
            prop: Type.String({ minLength: 1, maxLength: 64 }),
            map: Type.Record(Type.String(), uiPermissionIdSchema),
            default: uiPermissionIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object({ conversation: Type.Literal("read") }, { additionalProperties: false }),
]);
export type UiPermission = Static<typeof uiPermissionSchema>;

/** A permission once an offer's props chose it: an ID, or reading the conversation alone. */
export type UiResolvedPermission = UiPermissionId | { readonly conversation: "read" };

/**
 * The permission an action needs against an offer's stored props. Every server and client uses
 * this same function.
 */
export function uiActionPermission(
    action: { readonly permission?: UiPermission },
    props: unknown,
): UiResolvedPermission {
    const declared = action.permission;
    if (declared === undefined) return "content.write";
    if (typeof declared === "string") return declared;
    if ("conversation" in declared) return { conversation: "read" };
    const value =
        typeof props === "object" && props !== null && Object.hasOwn(props, declared.prop)
            ? (props as Record<string, unknown>)[declared.prop]
            : undefined;
    return typeof value === "string" && Object.hasOwn(declared.map, value)
        ? (declared.map[value] as UiPermissionId)
        : declared.default;
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
    if (typeof needed !== "string") return true;
    return Array.isArray(granted)
        ? granted.includes(needed)
        : (granted as ReadonlySet<string>).has(needed);
}
