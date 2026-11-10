import { Value } from "@sinclair/typebox/value";

import { uiActionDefinition, uiBundle, type UiBundleLookup } from "./catalog.js";

/**
 * The checks every server runs on chat UI beyond the TypeBox schemas, as English sentences a model
 * can act on. An empty list means it passes. Modules may refuse more for their own reasons, never
 * less. Each takes the lookup that finds a type's bundle: the catalog by default, and a server's
 * own served bundles on that server.
 */

/** Problems with one component's props, written by a model or the daemon. */
export function uiPropsProblems(
    component: { readonly type: string; readonly props: unknown },
    bundleOf: UiBundleLookup = uiBundle,
): string[] {
    const bundle = bundleOf(component.type);
    if (bundle === undefined) return [`There is no component type "${component.type}".`];
    if (!Value.Check(bundle.props, component.props)) {
        const first = Value.Errors(bundle.props, component.props).First();
        return [
            `The ${component.type} props are invalid${first === undefined ? "" : ` at "${first.path || "/"}": ${first.message}`}.`,
        ];
    }
    return [];
}

/** Problems with a document's components as a whole: 1–16, with unique IDs. */
export function uiDocumentProblems(
    components: readonly { readonly id: string; readonly type: string; readonly props: unknown }[],
    bundleOf: UiBundleLookup = uiBundle,
): string[] {
    const problems: string[] = [];
    if (components.length < 1 || components.length > 16) {
        problems.push("A document holds 1 to 16 components.");
    }
    const ids = components.map((component) => component.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
        problems.push(`Component IDs must be unique; "${repeated[0]}" repeats.`);
    }
    for (const component of components) {
        problems.push(
            ...uiPropsProblems(component, bundleOf).map((problem) => `${component.id}: ${problem}`),
        );
    }
    return problems;
}

/**
 * Why an action does not fit the offer it is sent to, or undefined when it does: the action
 * belongs to another component type, the bundle has no such action, or the payload fails its
 * schema. Each is a `400` on `/actions`.
 */
export function uiActionProblem(
    component: { readonly type: string; readonly props: unknown },
    action: { readonly type: string; readonly payload: unknown },
    bundleOf: UiBundleLookup = uiBundle,
): string | undefined {
    const found = uiActionDefinition(action.type, bundleOf);
    if (found === undefined || found.bundle.type !== component.type) {
        return `A ${component.type} component has no action "${action.type}".`;
    }
    if (!Value.Check(found.definition.payload, action.payload)) {
        return `That ${action.type} payload is invalid.`;
    }
    return undefined;
}
