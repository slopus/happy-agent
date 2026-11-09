import { CloneType, type TSchema } from "@sinclair/typebox";

/**
 * The JSON Schema keyword that marks a secret field. It appears as `"x-happy-secret": true` in
 * `ui.schema.json`, so every implementation of the contract can find the same fields.
 */
export const UI_SECRET_KEYWORD = "x-happy-secret";

/**
 * Mark a payload or result field as secret: a token, a code, a pairing payload. A secret is never
 * stored, put in an event, logged, or given to a model. It lives only in the request, the hook
 * that handles it, the result returned to the caller, and the store its module owns. A secret is
 * refused on a `"message"` action when the component is defined, so it cannot become someone's
 * words.
 */
export function UiSecret<T extends TSchema>(schema: T): T {
    return CloneType(schema, { [UI_SECRET_KEYWORD]: true }) as T;
}

/** Whether a schema is marked {@link UiSecret}. */
export function isUiSecret(schema: TSchema): boolean {
    return (schema as Record<string, unknown>)[UI_SECRET_KEYWORD] === true;
}

/** Whether a schema holds a secret anywhere inside it. */
export function containsUiSecret(schema: TSchema): boolean {
    if (isUiSecret(schema)) return true;
    const record = schema as Record<string, unknown>;
    const children: unknown[] = [];
    if (typeof record["properties"] === "object" && record["properties"] !== null) {
        children.push(...Object.values(record["properties"]));
    }
    if (typeof record["items"] === "object" && record["items"] !== null) {
        children.push(record["items"]);
    }
    for (const key of ["anyOf", "allOf", "oneOf"]) {
        if (Array.isArray(record[key])) children.push(...record[key]);
    }
    return children.some(
        (child) =>
            typeof child === "object" && child !== null && containsUiSecret(child as TSchema),
    );
}

/**
 * A payload or result with every secret left out, built from the schema's declared fields only:
 * a whitelist, so a field the schema does not name is left out too. This is the only form of a
 * payload that is ever stored, announced, or logged.
 */
export function redactUiValue(schema: TSchema, value: unknown): unknown {
    if (isUiSecret(schema)) return undefined;
    const record = schema as Record<string, unknown>;
    if (record["type"] === "object" && typeof record["properties"] === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
        const properties = record["properties"] as Record<string, TSchema>;
        const out: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(properties)) {
            if (!Object.hasOwn(value, name)) continue;
            const kept = redactUiValue(child, (value as Record<string, unknown>)[name]);
            if (kept !== undefined) out[name] = kept;
        }
        return out;
    }
    if (record["type"] === "array" && typeof record["items"] === "object") {
        if (!Array.isArray(value)) return [];
        const items = record["items"] as TSchema;
        if (isUiSecret(items)) return undefined;
        return value.map((item) => redactUiValue(items, item));
    }
    if (typeof value === "object" && value !== null) {
        // A union or other composite holding a secret is left out whole rather than guessed at.
        return containsUiSecret(schema) ? undefined : structuredClone(value);
    }
    return value;
}
