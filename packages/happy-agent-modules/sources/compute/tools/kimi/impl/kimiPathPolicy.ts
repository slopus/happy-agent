import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";
import type { Compute } from "../../../Compute.js";
import { describeComputePathAction } from "../../../impl/describeComputePathAction.js";
import { shouldReviewComputePath } from "../../../impl/shouldReviewComputePath.js";

/** Happy's explicit one-call escalation extension, separate from native Kimi arguments. */
export const kimiEscalationProperties = {
    sandbox_permissions: Type.Optional(
        Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
            description:
                "Request reviewed Full access for this exact call when the workspace sandbox blocks necessary work. Defaults to use_default.",
        }),
    ),
    justification: Type.Optional(
        Type.String({ description: "Concise reason why this call needs Full access." }),
    ),
};

const pathInputSchema = Type.Object({
    path: Type.Optional(Type.String()),
    ...kimiEscalationProperties,
});
type PathInput = Static<typeof pathInputSchema>;

/** Policies extract Kimi's actual path argument and use the shared canonical boundary. */
export function kimiPathPolicy(compute: Compute, write: boolean, operation: string) {
    const needsFullAccess = (input: PathInput, ctx: Context) =>
        input.sandbox_permissions === "require_escalated" ||
        shouldReviewComputePath(compute, input.path ?? ".", { write }, ctx);
    return {
        autoPermissionInstructions:
            "sandbox_permissions: require_escalated requests reviewed Full access for one call. Outside-workspace, symlink-escaping, and protected write paths are also reviewed automatically. Read only and Workspace write never elevate.",
        describeAutoPermissionAction: (input: PathInput) =>
            describeComputePathAction(compute, input.path ?? ".", operation, {
                write,
                fullAccess: input.sandbox_permissions === "require_escalated",
                ...(input.justification === undefined ? {} : { reason: input.justification }),
            }),
        shouldReviewInAutoMode: needsFullAccess,
        shouldRunInFullAccessInAutoMode: needsFullAccess,
    };
}
