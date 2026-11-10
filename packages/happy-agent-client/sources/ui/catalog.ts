import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { UiActionDefinition, UiBundle } from "./defineUiComponent.js";
import { defaultModelComponent } from "./components/defaultModel.js";
import { fileTreeComponent } from "./components/fileTree.js";
import { mediaComponent } from "./components/media.js";
import { providerSignInComponent } from "./components/providerSignIn.js";
import { uiFallbackSchema, uiSlugSchema } from "./uiValues.js";

/**
 * The catalog's version. It advances when a component or action is added or changed, and
 * `capabilities.chatUi.version` reports the one a server speaks.
 */
export const UI_CATALOG_VERSION = 1;

/**
 * Every component bundle, in catalog order. This is the only list: the known-component union, the
 * action union, and `ui.schema.json` are derived from it, so adding a component is one line here.
 * A server contributes the subset it can serve and lists exactly that subset in
 * `capabilities.chatUi.components`.
 */
export const uiComponents = [
    mediaComponent,
    fileTreeComponent,
    providerSignInComponent,
    defaultModelComponent,
] as const;

type KnownBundle = (typeof uiComponents)[number];

/**
 * One component as the wire carries it: `{ id, type, fallback, props }`, for any type. A document
 * may hold a type this build does not know, from a newer server; a client draws the types it knows
 * (see {@link knownUiComponent}) and shows `fallback` for the rest. A server checks every component
 * against its bundle before it writes a document, so what is stored is always valid for its type.
 */
export const uiWireComponentSchema = Type.Object({
    id: uiSlugSchema,
    type: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
    fallback: uiFallbackSchema,
    props: Type.Record(Type.String(), Type.Unknown()),
});
export type UiWireComponent = Static<typeof uiWireComponentSchema>;

/** One component of a type this catalog knows, with that type's props. */
export const uiComponentSchema = Type.Union(uiComponents.map((bundle) => bundle.componentSchema));
export type UiComponent = Static<KnownBundle["componentSchema"]>;
export type UiComponentType = UiComponent["type"];

/**
 * A wire component as its typed form, or undefined when its type is not in this catalog or its
 * props are not that type's: drawing code switches on the result's `type` and shows the wire
 * component's `fallback` for undefined.
 */
export function knownUiComponent(component: UiWireComponent): UiComponent | undefined {
    const bundle = uiBundle(component.type);
    if (bundle === undefined || !Value.Check(bundle.componentSchema, component)) return undefined;
    return component as UiComponent;
}

/** One action of any known type: `{ type: "<component>.<action>", payload }`. */
export const uiActionSchema = Type.Union(uiComponents.flatMap((bundle) => bundle.actionSchemas));

type ActionOf<B> =
    B extends UiBundle<infer TypeName, infer _Props, infer _Input, infer Actions>
        ? {
              [K in keyof Actions & string]: {
                  type: `${TypeName}.${K}`;
                  payload: Static<Actions[K]["payload"]>;
              };
          }[keyof Actions & string]
        : never;

/** One action of any known type, as a click sends it. */
export type UiAction = ActionOf<KnownBundle>;
export type UiActionType = UiAction["type"];

/** Finds a component type's bundle; the catalog's own lookup is {@link uiBundle}. */
export type UiBundleLookup = (type: string) => UiBundle | undefined;

/** The bundle of a component type, or undefined for a type this catalog does not know. */
export function uiBundle(type: string): UiBundle | undefined {
    return (uiComponents as readonly UiBundle[]).find((bundle) => bundle.type === type);
}

/**
 * An action type's bundle, name, and definition: its payload, result, and permission. A server
 * passes its own lookup, the bundles it serves; everything else reads the catalog.
 */
export function uiActionDefinition(
    actionType: string,
    bundleOf: UiBundleLookup = uiBundle,
):
    | {
          readonly bundle: UiBundle;
          readonly name: string;
          readonly definition: UiActionDefinition;
      }
    | undefined {
    const dot = actionType.indexOf(".");
    if (dot < 1) return undefined;
    const bundle = bundleOf(actionType.slice(0, dot));
    const name = actionType.slice(dot + 1);
    if (bundle === undefined || !Object.hasOwn(bundle.actions, name)) return undefined;
    return { bundle, name, definition: bundle.actions[name]! };
}
