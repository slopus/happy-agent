import { Type, type Static, type TLiteral, type TObject } from "@sinclair/typebox";

/**
 * A reply component: a small drawing beside one quick-reply option, such as an AI's mark and its
 * live sign-in state. It is display-only, with no actions and no secrets, and stays on one line;
 * tapping the option always sends the option's text.
 */
export interface ReplyBundle<TypeName extends string = string, Props extends TObject = TObject> {
    /** The component's type, a lowercase slug. */
    readonly type: TypeName;
    /** The props stored on the wire and drawn by clients. */
    readonly props: Props;
    /** `{ type, props }`: the component as an option's `ui` carries it. */
    readonly schema: TObject<{ type: TLiteral<TypeName>; props: Props }>;
}

export type ReplyPropsOf<B extends ReplyBundle> = Static<B["props"]>;

const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Define one reply component. Throws on a malformed type. */
export function defineReplyComponent<const TypeName extends string, Props extends TObject>(
    type: TypeName,
    props: Props,
): ReplyBundle<TypeName, Props> {
    if (!TYPE_PATTERN.test(type)) throw new Error(`"${type}" is not a valid reply type.`);
    return {
        type,
        props,
        schema: Type.Object({ type: Type.Literal(type), props }, { additionalProperties: false }),
    };
}
