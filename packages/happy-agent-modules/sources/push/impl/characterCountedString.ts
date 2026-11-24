import { Kind, Type, TypeRegistry, type TUnsafe } from "@sinclair/typebox";

import { characterCountPattern } from "./characterCountPattern.js";

/**
 * Names the check below, and is what a refused value is told it was expected to be, so it reads as
 * the rule rather than as an identifier.
 */
const CHARACTER_COUNTED_STRING = "string within minLength and maxLength, counted in characters";

interface CharacterCountedStringSchema {
    readonly minLength?: number;
    readonly maxLength: number;
}

if (!TypeRegistry.Has(CHARACTER_COUNTED_STRING)) {
    TypeRegistry.Set<CharacterCountedStringSchema>(CHARACTER_COUNTED_STRING, (schema, value) => {
        if (typeof value !== "string") return false;
        // No text within the limit is longer than this, and it keeps the pattern off long input.
        if (value.length > schema.maxLength * 2) return false;
        return new RegExp(characterCountPattern(schema.minLength ?? 0, schema.maxLength), "u").test(
            value,
        );
    });
}

/**
 * A string of `minimum` to `maximum` characters that a model is shown as an ordinary JSON Schema
 * string with `minLength` and `maxLength`.
 *
 * JSON Schema counts those limits in characters, and so does Happy Cloud, but the validator here
 * counts a plain string schema in UTF-16 units and would refuse 41 emoji in a field that allows
 * 80. This checks what the schema says instead: a character outside the Basic Multilingual Plane
 * counts once, and half of a surrogate pair is refused. The schema a model receives is unchanged.
 */
export function characterCountedString(minimum: number, maximum: number): TUnsafe<string> {
    // The keys are in the order a plain string schema has them, so the request a model receives
    // is the same byte for byte.
    return Type.Unsafe<string>({
        ...(minimum > 0 ? { minLength: minimum } : {}),
        maxLength: maximum,
        [Kind]: CHARACTER_COUNTED_STRING,
        type: "string",
    });
}
