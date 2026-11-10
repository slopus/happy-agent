import { Type, type Static, type TLiteral, type TObject } from "@sinclair/typebox";

import type { UiPermission } from "./permission.js";
import { uiFallbackSchema, uiSlugSchema } from "./uiValues.js";

/**
 * One action a component can send. Every action is silent: it never becomes the person's words,
 * and the component shows its own pending and error state.
 */
export interface UiActionDefinition {
    /** The strict payload a click sends. */
    readonly payload: TObject;
    /** What the action returns to the caller alone, never stored; absent for none. */
    readonly result?: TObject;
    /** What the clicking person must hold; absent means `content.write`. */
    readonly permission?: UiPermission;
}

export interface UiComponentDefinition<
    TypeName extends string,
    Props extends TObject,
    Input extends TObject,
    Actions extends Readonly<Record<string, UiActionDefinition>>,
> {
    /** The component's type, a lowercase slug. */
    readonly type: TypeName;
    /** One sentence on what the component is, for `ui.schema.json`. */
    readonly description: string;
    /** The props stored on the wire and drawn by clients. */
    readonly props: Props;
    /**
     * What the model or the daemon writes, when it differs from `props`: `media` takes file paths
     * that become media indexes. Absent means `props`.
     */
    readonly input?: Input;
    readonly actions: Actions;
}

/** A component bundle: its props, its actions, and the wire schemas derived from them. */
export interface UiBundle<
    TypeName extends string = string,
    Props extends TObject = TObject,
    Input extends TObject = TObject,
    Actions extends Readonly<Record<string, UiActionDefinition>> = Readonly<
        Record<string, UiActionDefinition>
    >,
> extends UiComponentDefinition<TypeName, Props, Input, Actions> {
    readonly input: Input;
    /** `{ id, fallback, type, props }`: the component as a document carries it. */
    readonly componentSchema: TObject<{
        id: typeof uiSlugSchema;
        fallback: typeof uiFallbackSchema;
        type: TLiteral<TypeName>;
        props: Props;
    }>;
    /** `{ type: "<type>.<action>", payload }`, one per action. */
    readonly actionSchemas: readonly TObject[];
}

export type PropsOf<B extends UiBundle> = Static<B["props"]>;
export type InputOf<B extends UiBundle> = Static<B["input"]>;
export type ActionNamesOf<B extends UiBundle> = keyof B["actions"] & string;
export type PayloadOf<B extends UiBundle, K extends ActionNamesOf<B>> = Static<
    B["actions"][K]["payload"]
>;
export type ResultOf<
    B extends UiBundle,
    K extends ActionNamesOf<B>,
> = B["actions"][K]["result"] extends TObject ? Static<B["actions"][K]["result"]> : never;

const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Define one component bundle. Throws on a malformed type or action name. */
export function defineUiComponent<
    const TypeName extends string,
    Props extends TObject,
    Actions extends Readonly<Record<string, UiActionDefinition>>,
    Input extends TObject = Props,
>(
    definition: UiComponentDefinition<TypeName, Props, Input, Actions>,
): UiBundle<TypeName, Props, Input, Actions> {
    if (!TYPE_PATTERN.test(definition.type)) {
        throw new Error(`"${definition.type}" is not a valid component type.`);
    }
    for (const name of Object.keys(definition.actions)) {
        if (!TYPE_PATTERN.test(name)) {
            throw new Error(`"${definition.type}.${name}" is not a valid action name.`);
        }
    }
    const input = (definition.input ?? definition.props) as Input;
    return {
        ...definition,
        input,
        componentSchema: Type.Object(
            {
                id: uiSlugSchema,
                fallback: uiFallbackSchema,
                type: Type.Literal(definition.type),
                props: definition.props,
            },
            { additionalProperties: false },
        ),
        actionSchemas: Object.entries(definition.actions).map(([name, action]) =>
            Type.Object(
                {
                    type: Type.Literal(`${definition.type}.${name}`),
                    payload: action.payload,
                },
                { additionalProperties: false },
            ),
        ),
    };
}
