import type { TSchema } from "@sinclair/typebox";

/**
 * Converts a regex pattern constraint into a human readable note for descriptions.
 * The raw pattern is never sent to models.
 */
function patternToDescription(pattern: string): string {
    // Secret values may contain newlines (for example, PEM keys); only NUL is banned.
    if (pattern === "^[^\\u0000]*$" || pattern === "^[^\u0000]*$") {
        return "Must not contain null bytes.";
    }

    // Common "no control or newline" patterns used across the codebase.
    if (
        pattern.includes("\\u0000") ||
        pattern.includes("\u0000") ||
        /\^?\[\^?\\u0000/.test(pattern)
    ) {
        return "Must not contain null bytes or line break characters.";
    }

    // Unicode control / format / etc. using property escapes (the source of provider rejections).
    if (/\\p\{[CcFfNnZzMm]/.test(pattern) || /control|Cc|Cf|Cn|Cs|Zl|Zp/.test(pattern)) {
        return "Must consist of visible characters without control codes, line separators, or private-use characters.";
    }

    // Simple positive digit sequences.
    if (/^\^?\[0-9\]\+\$/.test(pattern) || /^\^\[0-9\]\+\$/.test(pattern)) {
        return "Must be one or more decimal digits.";
    }

    // 64 char hex (e.g. avatar hashes).
    if (/^\^?\[a-f0-9\]\{64\}\$/.test(pattern)) {
        return "Must be a 64-character lowercase hexadecimal string.";
    }

    // UUIDv7-ish.
    if (/7[0-9a-f]{3}-[89ab]/.test(pattern) && /[0-9a-f]{8}-/.test(pattern)) {
        return "Must be a valid UUIDv7 identifier.";
    }

    // If the pattern uses advanced features, give a generic note rather than embedding syntax.
    if (/\\[pP]\{|\(\?|\(\?!|\(\?<|(?<=)/.test(pattern)) {
        return "Must satisfy the required format.";
    }

    return "Must match the required format.";
}

/**
 * Recursively sanitizes a JSON Schema (or TypeBox serialized) node:
 * - Removes regex constraints, projecting patterned dictionary values onto `additionalProperties`.
 * - Automatically injects a human description of the removed pattern constraint.
 * - Recurses into standard schema containers.
 */
function sanitizeNode(node: unknown): unknown {
    if (node == null || typeof node !== "object") {
        return node;
    }
    if (Array.isArray(node)) {
        return node.map(sanitizeNode);
    }

    const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };

    // Strip regex pattern and lift to description.
    if (typeof out.pattern === "string") {
        const pat = out.pattern;
        delete out.pattern;
        const note = patternToDescription(pat);
        const prev = typeof out.description === "string" ? (out.description as string).trim() : "";
        if (note) {
            out.description = prev
                ? prev.endsWith(".") || prev.endsWith("!")
                    ? `${prev} ${note}`
                    : `${prev}. ${note}`
                : note;
        }
    }

    // Patterned keys cannot reach the provider, but their value schemas must survive.
    // Once the key patterns are removed, an unknown key may have matched any one of
    // them or the original additionalProperties schema. A union is therefore the
    // safe wire approximation; the unchanged original still validates calls locally.
    if ("patternProperties" in out) {
        const values = Object.values(out.patternProperties as Record<string, unknown>);
        // An omitted or true fallback already allows every value. Keep its wire
        // representation unchanged rather than expanding unconstrained dictionaries.
        if (
            values.length > 0 &&
            out.additionalProperties !== undefined &&
            out.additionalProperties !== true
        ) {
            if (out.additionalProperties !== false) values.push(out.additionalProperties);
            out.additionalProperties = values.length === 1 ? values[0] : { anyOf: values };
        }
        delete out.patternProperties;
    }

    // Recurse into common subschema locations.
    const singleRecurse = [
        "additionalProperties",
        "items",
        "contains",
        "not",
        "if",
        "then",
        "else",
    ];
    for (const k of singleRecurse) {
        if (k in out) {
            out[k] = sanitizeNode(out[k]);
        }
    }

    const arrayRecurse = ["prefixItems", "allOf", "anyOf", "oneOf"];
    for (const k of arrayRecurse) {
        if (Array.isArray(out[k])) {
            out[k] = (out[k] as unknown[]).map(sanitizeNode);
        }
    }

    // definitions / $defs
    for (const k of ["$defs", "definitions"]) {
        const defs = out[k];
        if (defs && typeof defs === "object" && !Array.isArray(defs)) {
            const next: Record<string, unknown> = {};
            for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
                next[name] = sanitizeNode(def);
            }
            out[k] = next;
        }
    }

    // properties map
    if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
        const next: Record<string, unknown> = {};
        for (const [name, prop] of Object.entries(out.properties as Record<string, unknown>)) {
            next[name] = sanitizeNode(prop);
        }
        out.properties = next;
    }

    return out;
}

/**
 * Prepares a tool's parameters schema for emission to a model provider.
 *
 * - If no schema is provided, returns a safe empty object schema.
 * - Ensures the top level is always an object schema (throws if a non-object root is supplied).
 * - Strips every `pattern` / `patternProperties` (any regex) so that unsupported syntax
 *   such as Unicode property escapes never reaches the provider. Patterned dictionary
 *   value schemas become `additionalProperties`, unioned with any existing fallback.
 * - When a pattern is removed, a human-readable description of the constraint is
 *   automatically added (or appended) to the field's description.
 *
 * The original TypeBox schema (with patterns) is retained for Rig-side validation.
 */
export function toLlmParametersSchema(schema?: TSchema): Record<string, unknown> {
    let root: any;

    if (!schema) {
        root = { type: "object", properties: {}, additionalProperties: false };
    } else {
        root = JSON.parse(JSON.stringify(schema));
    }

    root = sanitizeNode(root);

    if (!root || typeof root !== "object" || Array.isArray(root)) {
        root = { type: "object", properties: {}, additionalProperties: false };
    }

    if (root.type !== "object") {
        throw new Error("Tool parameters schema must be an object at the top level.");
    }

    if (!root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
        root.properties = {};
    }

    return root as Record<string, unknown>;
}
