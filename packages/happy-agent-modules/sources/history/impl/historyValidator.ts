import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler, type TypeCheck } from "@sinclair/typebox/compiler";

const validators = new WeakMap<TSchema, TypeCheck<TSchema>>();

/** Compile each fixed history schema once; never retain messages or caller state. */
export function historyValidator<Schema extends TSchema>(schema: Schema): TypeCheck<Schema> {
    let validator = validators.get(schema);
    if (validator === undefined) {
        validator = TypeCompiler.Compile(schema);
        validators.set(schema, validator);
    }
    return validator as TypeCheck<Schema>;
}
