import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { visit } from "jsonc-parser";

import {
    autoPermissionRiskSchema,
    autoPermissionUserAuthorizationSchema,
    type AutoPermissionReview,
} from "./parseAutoPermissionReview.js";

/** The private reviewer's native structured-output contract. No decision field has a default. */
export const structuredGuardianReviewSchema = Type.Object(
    {
        risk_level: autoPermissionRiskSchema,
        user_authorization: autoPermissionUserAuthorizationSchema,
        outcome: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
        rationale: Type.String({ minLength: 1, pattern: "\\S" }),
    },
    { additionalProperties: false },
);

type StructuredGuardianReview = Static<typeof structuredGuardianReviewSchema>;

/** Read exactly one complete JSON decision; prose, missing fields, and refusals fail closed. */
export function parseStructuredGuardianReview(text: string): AutoPermissionReview | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
        if (!uniqueProperties(text)) return undefined;
    } catch {
        return undefined;
    }
    if (!Value.Check(structuredGuardianReviewSchema, parsed)) return undefined;
    return toReview(parsed);
}

/** JSON.parse discards duplicate keys. Reject that ambiguity before trusting any decision. */
function uniqueProperties(text: string): boolean {
    const objects: Set<string>[] = [];
    let unique = true;
    visit(
        text,
        {
            onObjectBegin: () => {
                objects.push(new Set());
            },
            onObjectProperty: (name) => {
                const object = objects.at(-1);
                if (object === undefined || object.has(name)) unique = false;
                object?.add(name);
            },
            onObjectEnd: () => {
                objects.pop();
            },
            onError: () => {
                unique = false;
            },
        },
        { disallowComments: true, allowTrailingComma: false },
    );
    return unique;
}

function toReview(review: StructuredGuardianReview): AutoPermissionReview {
    const rationale = review.rationale.replace(/\s+/gu, " ").trim();
    const reason = rationale.length <= 240 ? rationale : `${rationale.slice(0, 237)}…`;
    return {
        decision: review.outcome,
        ...(review.outcome === "deny" ? { denialKind: "rejected" as const } : {}),
        risk: review.risk_level,
        userAuthorization: review.user_authorization,
        reason,
    };
}
