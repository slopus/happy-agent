import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CloudInvitationConflictError,
    CloudOrganizationForbiddenError,
    CloudOrganizationInvalidRequestError,
    CloudServiceUnavailableError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";
import { normalizeHappyTeamInvitationEmail } from "../../sources/cloud/HappyTeamInvitation.js";

const invitation = {
    acceptedAt: null,
    acceptanceLink: "https://signin.example/invite?invitation_token=recipient-secret",
    createdAt: "2026-09-10T00:00:00Z",
    email: "person@example.com",
    expiresAt: "2026-09-17T00:00:00Z",
    id: "invitation_created",
    revokedAt: null,
    status: "pending",
};

afterEach(() => vi.unstubAllGlobals());

describe("Happy Cloud invitations", () => {
    it("sends only the normalized email to the selected deployment's invitation route", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ invitation }, { status: 201 }));
        vi.stubGlobal("fetch", request);
        await expect(
            new CloudWorkOS("staging").inviteTeamMember(
                "access-token",
                "org_team",
                " Person@Example.COM ",
            ),
        ).resolves.toEqual(invitation);
        expect(request).toHaveBeenCalledOnce();
        const [url, init] = request.mock.calls[0]!;
        expect(String(url)).toBe(
            "https://happy-cloud-staging.bulka-llc.workers.dev/v0/organizations/org_team/invitations",
        );
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ email: "person@example.com" }));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    });

    it("validates email addresses like the worker and rejects invalid IDs before network access", async () => {
        expect(normalizeHappyTeamInvitationEmail(" Ada+Team@Example.COM ")).toBe(
            "ada+team@example.com",
        );
        const request = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", request);
        for (const email of [
            "a@localhost",
            ".a@example.com",
            "a.@example.com",
            "a..b@example.com",
            "a@@example.com",
            "a@-example.com",
            "a@example-.com",
            "a@exam_ple.com",
            "é@example.com",
            "a b@example.com",
            `${"a".repeat(65)}@example.com`,
            `a@${"b".repeat(64)}.com`,
        ]) {
            expect(normalizeHappyTeamInvitationEmail(email), email).toBeUndefined();
            await expect(
                new CloudWorkOS("production").inviteTeamMember("access", "org_team", email),
            ).rejects.toBeInstanceOf(CloudOrganizationInvalidRequestError);
        }
        await expect(
            new CloudWorkOS("production").inviteTeamMember(
                "access",
                "org_team/escape",
                "person@example.com",
            ),
        ).rejects.toBeInstanceOf(CloudOrganizationInvalidRequestError);
        expect(request).not.toHaveBeenCalled();
    });

    it.each([
        [400, "invalid_invitation", CloudOrganizationInvalidRequestError],
        [403, "forbidden", CloudOrganizationForbiddenError],
        [409, "already_member", CloudInvitationConflictError],
        [409, "pending_invitation", CloudInvitationConflictError],
        [409, "unknown", CloudServiceUnavailableError],
        [502, "organizations_unavailable", CloudServiceUnavailableError],
    ] as const)(
        "handles %s %s without replaying the invitation",
        async (status, error, errorClass) => {
            const request = vi
                .fn<typeof fetch>()
                .mockImplementation(async () => Response.json({ error }, { status }));
            vi.stubGlobal("fetch", request);
            await expect(
                new CloudWorkOS("production").inviteTeamMember(
                    "access",
                    "org_team",
                    "person@example.com",
                ),
            ).rejects.toBeInstanceOf(errorClass);
            expect(request).toHaveBeenCalledOnce();
        },
    );

    it.each([
        { email: "other@example.com" },
        { status: "accepted" },
        { acceptanceLink: null },
        { acceptanceLink: "javascript:alert(1)" },
        { acceptanceLink: "https://user:password@signin.example/" },
        { refreshToken: "must-not-escape" },
    ])("rejects mismatched or unsafe invitation responses: %j", async (change) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({ invitation: { ...invitation, ...change } }, { status: 201 }),
            ),
        );
        await expect(
            new CloudWorkOS("production").inviteTeamMember(
                "access",
                "org_team",
                "person@example.com",
            ),
        ).rejects.toBeInstanceOf(CloudServiceUnavailableError);
    });

    it("does not retry an ambiguous transport failure or oversized result", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new Error("raw access-token recipient-secret"))
            .mockResolvedValueOnce(
                Response.json({ invitation, padding: "x".repeat(9_000) }, { status: 201 }),
            );
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("production");
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(
                client.inviteTeamMember("access", "org_team", "person@example.com"),
            ).rejects.toThrow("Cloud authentication is temporarily unavailable.");
        }
        expect(request).toHaveBeenCalledTimes(2);
    });
});
