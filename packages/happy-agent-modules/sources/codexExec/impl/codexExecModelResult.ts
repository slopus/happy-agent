/**
 * A tool result's `presentation` is what History records for people to see: a diff with every
 * line, a command with its output. It is never meant for the model, which reads a direct call
 * through `toLLM`. Inside `exec` the script receives the result itself, so `presentation` is
 * removed here; carried along it was most of every patch result, read again on every request.
 */
const PRESENTATION_FIELD = "presentation";

/** The value a script receives from one nested call. */
export function codexExecModelResult(result: unknown): unknown {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
    if (!Object.hasOwn(result, PRESENTATION_FIELD)) return result;
    const { [PRESENTATION_FIELD]: _presentation, ...rest } = result as Record<string, unknown>;
    return rest;
}

/** The result schema a nested tool is declared with, which matches what the script receives. */
export function codexExecModelResultSchema(schema: unknown): unknown {
    if (typeof schema !== "object" || schema === null) return schema;
    const node = schema as { properties?: Record<string, unknown>; required?: readonly string[] };
    if (node.properties === undefined || !Object.hasOwn(node.properties, PRESENTATION_FIELD)) {
        return schema;
    }
    const { [PRESENTATION_FIELD]: _presentation, ...properties } = node.properties;
    return {
        ...node,
        properties,
        ...(node.required === undefined
            ? {}
            : { required: node.required.filter((name) => name !== PRESENTATION_FIELD) }),
    };
}
