import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler, type TypeCheck } from "@sinclair/typebox/compiler";

const validators = new WeakMap<TSchema, TypeCheck<TSchema>>();

/**
 * Compile each fixed projection schema once; never retain projected values.
 *
 * Desktop history loads check every tool call's arguments and presentation, and interpreting
 * those nested schemas on each check cost more than reading the messages.
 */
export function apiValidator<Schema extends TSchema>(schema: Schema): TypeCheck<Schema> {
    let validator = validators.get(schema);
    if (validator === undefined) {
        validator = TypeCompiler.Compile(schema);
        validators.set(schema, validator);
    }
    return validator as TypeCheck<Schema>;
}
