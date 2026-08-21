import { Type, type Static } from "@sinclair/typebox";

export const globalSecurityPolicySchema = Type.Object(
    {
        policy: Type.String(),
    },
    { additionalProperties: false },
);

export type GetGlobalSecurityPolicyResponse = Static<typeof globalSecurityPolicySchema>;
export type UpdateGlobalSecurityPolicyRequest = Static<typeof globalSecurityPolicySchema>;
export type UpdateGlobalSecurityPolicyResponse = GetGlobalSecurityPolicyResponse;
