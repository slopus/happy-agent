import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const happyTeamInvitationOrganizationIdSchema = Type.String({
    pattern: "^org_[a-zA-Z0-9]{1,508}$",
});

export const happyTeamInvitationEmailInputSchema = Type.String({ minLength: 3, maxLength: 512 });

/** The normalized email syntax accepted by Happy Cloud's invitation endpoint. */
const invitationEmailSchema = Type.String({
    minLength: 3,
    maxLength: 254,
    pattern:
        "^(?=[^@]{1,64}@)(?!\\.)(?![^@]*\\.\\.)(?![^@]*\\.@)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$",
});

/** Normalize before validation, exactly as the Happy Cloud worker does. */
export function normalizeHappyTeamInvitationEmail(value: string): string | undefined {
    if (!Value.Check(happyTeamInvitationEmailInputSchema, value)) return undefined;
    const email = value.trim().toLowerCase();
    return Value.Check(invitationEmailSchema, email) ? email : undefined;
}

/** A freshly created member invitation. Its acceptance link is recipient-sensitive. */
export const happyTeamInvitationSchema = Type.Object(
    {
        acceptedAt: Type.Null(),
        acceptanceLink: Type.String({
            maxLength: 4_096,
            pattern: "^https://[^\\s/@?#\\\\]+(?:[/?#][^\\s\\\\]*)?$",
        }),
        createdAt: Type.String({ minLength: 1, maxLength: 64 }),
        email: invitationEmailSchema,
        expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
        id: Type.String({ minLength: 1, maxLength: 512 }),
        revokedAt: Type.Null(),
        status: Type.Literal("pending"),
    },
    { additionalProperties: false },
);
export type HappyTeamInvitation = Static<typeof happyTeamInvitationSchema>;
