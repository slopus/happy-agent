import { Type, type Static, type TLiteral, type TObject } from "@sinclair/typebox";

import { containsUiSecret } from "./secret.js";
import type { UiPermission } from "./permission.js";
import { uiFallbackSchema, uiSlugSchema } from "./uiValues.js";

/** Whether a successful action can become the person's words, or stays inside its component. */
export type UiTranscript = "message" | "silent";

/** One action a component can send. */
export interface UiActionDefinition {
    /** The strict payload a click sends. */
    readonly payload: TObject;
    /** What the action returns to the caller alone, never stored; absent for none. */
    readonly result?: TObject;
    /**
     * `"message"`: a successful action can become the person's words, and clients show an
     * optimistic bubble. `"silent"`: no bubble; the component shows its own pending and error state.
     */
    readonly transcript: UiTranscript;
    /** The action answers the offer: after the first accepted one, the offer is closed. */
    readonly once?: boolean;
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
     * What the model or the daemon writes, when it differs from `props`: `images` takes file paths
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
export type TranscriptOf<
    B extends UiBundle,
    K extends ActionNamesOf<B>,
> = B["actions"][K]["transcript"];

const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Define one component bundle. Throws on a malformed type or action name, and on a secret in a
 * `"message"` action's payload, so a secret can never become someone's words.
 */
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
    for (const [name, action] of Object.entries(definition.actions)) {
        if (!TYPE_PATTERN.test(name)) {
            throw new Error(`"${definition.type}.${name}" is not a valid action name.`);
        }
        if (action.transcript === "message" && containsUiSecret(action.payload)) {
            throw new Error(
                `"${definition.type}.${name}" becomes the person's words, so it can't carry a secret.`,
            );
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
