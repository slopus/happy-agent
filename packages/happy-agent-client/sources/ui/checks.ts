import { Value } from "@sinclair/typebox/value";

import { uiActionDefinition, uiBundle } from "./catalog.js";

/**
 * The checks every server runs on chat UI beyond the TypeBox schemas, as English sentences a model
 * can act on. An empty list means it passes. Modules may refuse more for their own reasons, never
 * less.
 */

/** Problems with one component's props, written by a model or the daemon. */
export function uiPropsProblems(component: {
    readonly type: string;
    readonly props: unknown;
}): string[] {
    const bundle = uiBundle(component.type);
    if (bundle === undefined) return [`There is no component type "${component.type}".`];
    if (!Value.Check(bundle.props, component.props)) {
        const first = Value.Errors(bundle.props, component.props).First();
        return [
            `The ${component.type} props are invalid${first === undefined ? "" : ` at "${first.path || "/"}": ${first.message}`}.`,
        ];
    }
    const props = component.props as Record<string, unknown>;
    const problems: string[] = [];
    const options = Array.isArray(props["options"])
        ? (props["options"] as { id: string; primary?: boolean }[])
        : [];
    const ids = options.map((option) => option.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
        problems.push(`Option IDs must be unique; "${repeated[0]}" repeats.`);
    }
    if (options.filter((option) => option.primary === true).length > 1) {
        problems.push("At most one option may be primary.");
    }
    return problems;
}

/** Problems with a document's components as a whole: 1–16, with unique IDs. */
export function uiDocumentProblems(
    components: readonly { readonly id: string; readonly type: string; readonly props: unknown }[],
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
            ...uiPropsProblems(component).map((problem) => `${component.id}: ${problem}`),
        );
    }
    return problems;
}

/**
 * Why an action does not fit the offer it is sent to, or undefined when it does: the action
 * belongs to another component type, the bundle has no such action, the payload fails its schema,
 * or it names an option the offer does not have. Each is a `400` on `/actions`.
 */
export function uiActionProblem(
    component: { readonly type: string; readonly props: unknown },
    action: { readonly type: string; readonly payload: unknown },
): string | undefined {
    const found = uiActionDefinition(action.type);
    if (found === undefined || found.bundle.type !== component.type) {
        return `A ${component.type} component has no action "${action.type}".`;
    }
    if (!Value.Check(found.definition.payload, action.payload)) {
        return `That ${action.type} payload is invalid.`;
    }
    const props = component.props as Record<string, unknown>;
    const payload = action.payload as Record<string, unknown>;
    const offered = Array.isArray(props["options"])
        ? (props["options"] as { id: string }[]).map((option) => option.id)
        : [];
    if (action.type === "choice.choose" && !offered.includes(payload["optionId"] as string)) {
        return "That option isn't offered.";
    }
    if (
        action.type === "checklist.submit" &&
        (payload["selected"] as string[]).some((id) => !offered.includes(id))
    ) {
        return "That option isn't offered.";
    }
    return undefined;
}
