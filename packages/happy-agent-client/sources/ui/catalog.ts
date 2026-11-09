import { Type, type Static } from "@sinclair/typebox";

import type { UiActionDefinition, UiBundle } from "./defineUiComponent.js";
import { checklistComponent } from "./components/checklist.js";
import { choiceComponent } from "./components/choice.js";
import { defaultModelComponent } from "./components/defaultModel.js";
import { fileTreeComponent } from "./components/fileTree.js";
import { imagesComponent } from "./components/images.js";
import { phoneAppComponent, phonePairComponent } from "./components/phone.js";
import { providerSignInComponent } from "./components/providerSignIn.js";
import {
    computeJoinComponent,
    githubConnectComponent,
    inviteComponent,
    notificationsComponent,
    serverLinkComponent,
} from "./components/team.js";
import { textFieldComponent } from "./components/textField.js";

/**
 * The catalog's version. It advances when a component or action is added or changed, and
 * `capabilities.chatUi.version` reports the one a server speaks.
 */
export const UI_CATALOG_VERSION = 1;

/**
 * Every component bundle, in catalog order. A server contributes the subset it can serve and
 * lists exactly that subset in `capabilities.chatUi.components`.
 */
export const uiComponents = [
    imagesComponent,
    choiceComponent,
    checklistComponent,
    textFieldComponent,
    fileTreeComponent,
    providerSignInComponent,
    defaultModelComponent,
    phoneAppComponent,
    phonePairComponent,
    inviteComponent,
    githubConnectComponent,
    computeJoinComponent,
    serverLinkComponent,
    notificationsComponent,
] as const;

/** The components only team servers contribute. */
export const TEAM_UI_COMPONENT_TYPES: readonly UiComponentType[] = [
    "invite",
    "github_connect",
    "compute_join",
    "server_link",
    "notifications",
];

/** One wire component of any known type: `{ id, fallback, type, props }`. */
export const uiComponentSchema = Type.Union([
    imagesComponent.componentSchema,
    choiceComponent.componentSchema,
    checklistComponent.componentSchema,
    textFieldComponent.componentSchema,
    fileTreeComponent.componentSchema,
    providerSignInComponent.componentSchema,
    defaultModelComponent.componentSchema,
    phoneAppComponent.componentSchema,
    phonePairComponent.componentSchema,
    inviteComponent.componentSchema,
    githubConnectComponent.componentSchema,
    computeJoinComponent.componentSchema,
    serverLinkComponent.componentSchema,
    notificationsComponent.componentSchema,
]);
export type UiComponent = Static<typeof uiComponentSchema>;
export type UiComponentType = UiComponent["type"];

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
export type UiAction = ActionOf<(typeof uiComponents)[number]>;
export type UiActionType = UiAction["type"];

/** The bundle of a component type, or undefined for a type this catalog does not know. */
export function uiBundle(type: string): UiBundle | undefined {
    return (uiComponents as readonly UiBundle[]).find((bundle) => bundle.type === type);
}

/** An action type's bundle, name, and definition: its transcript, `once`, and permission. */
export function uiActionDefinition(actionType: string):
    | {
          readonly bundle: UiBundle;
          readonly name: string;
          readonly definition: UiActionDefinition;
      }
    | undefined {
    const dot = actionType.indexOf(".");
    if (dot < 1) return undefined;
    const bundle = uiBundle(actionType.slice(0, dot));
    const name = actionType.slice(dot + 1);
    if (bundle === undefined || !Object.hasOwn(bundle.actions, name)) return undefined;
    return { bundle, name, definition: bundle.actions[name]! };
}
