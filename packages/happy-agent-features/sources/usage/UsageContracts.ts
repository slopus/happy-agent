import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/**
 * Context is a class-backed value with non-enumerable extension state.  The
 * feature never inspects that state, but still gives TypeBox a closed,
 * provider-neutral structural contract instead of using an unconstrained
 * schema.
 */
export const usageContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

/** A callback may complete synchronously or return a Promise that resolves to void. */
export const usageVoidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
