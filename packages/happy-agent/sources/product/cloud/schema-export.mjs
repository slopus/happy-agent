// Build-time capture only. The native owner runs against serialized TypeBox,
// never JavaScript or a reconstructed public contract.
import { createRequire } from "node:module";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import {
    cloudStoredStateSchema,
    cloudVersionSchema,
} from "../../../../happy-agent-modules/sources/cloud/CloudDatabase.ts";
import {
    cloudAuthorizationExpiryArgumentsSchema,
    cloudSessionRefreshArgumentsSchema,
} from "../../../../happy-agent-modules/sources/cloud/CloudDurableFunctions.ts";
import {
    happyTeamSchema,
    happyTeamEndpointInputSchema,
    happyTeamEndpointSchema,
} from "../../../../happy-agent-modules/sources/cloud/HappyTeam.ts";
import {
    happyTeamInvitationSchema,
    happyTeamInvitationOrganizationIdSchema,
    happyTeamInvitationEmailInputSchema,
} from "../../../../happy-agent-modules/sources/cloud/HappyTeamInvitation.ts";
import { shortLivedWorkOSTokenSchema } from "../../../../happy-agent-modules/sources/cloud/shortLivedWorkOSToken.ts";

const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
const client = await import(require.resolve("@slopus/happy-agent-client"));
const database = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/cloud/CloudDatabase.ts", import.meta.url),
    ["cloudSessionSchema", "cloudStoredValueSchema"],
);
const workos = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/cloud/CloudWorkOS.ts", import.meta.url),
    [
        "workosAuthenticationSchema",
        "authorizationSchema",
        "helloSchema",
        "cloudOrganizationsResponseSchema",
        "remoteHappyTeamSchema",
        "happyTeamsResponseSchema",
        "invalidOrganizationSchema",
        "organizationForbiddenSchema",
        "invalidOrganizationEndpointSchema",
        "organizationEndpointResponseSchema",
        "organizationNotFoundSchema",
        "organizationDeletedSchema",
        "invitationResponseSchema",
        "invitationConflictSchema",
    ],
);
const organization = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/cloud/organizationAccessToken.ts",
        import.meta.url,
    ),
    ["claimsSchema"],
);
const short = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/cloud/shortLivedWorkOSToken.ts",
        import.meta.url,
    ),
    ["claimsSchema"],
);
const invitation = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/cloud/HappyTeamInvitation.ts",
        import.meta.url,
    ),
    ["invitationEmailSchema"],
);
const exact = { additionalProperties: false };
const user = workos.workosAuthenticationSchema.properties.user.properties;
export const cloudSchemas = {
    cloudSnapshot: client.cloudSchema,
    cloudEnvironment: client.cloudEnvironmentSchema,
    cloudStartRequest: client.startCloudAuthorizationRequestSchema,
    cloudCompleteRequest: client.completeCloudAuthorizationRequestSchema,
    cloudMutationRequest: client.cloudMutationRequestSchema,
    cloudCreateOrganizationRequest: client.createCloudOrganizationRequestSchema,
    cloudOrganization: client.cloudOrganizationSchema,
    cloudOrganizationId: client.cloudOrganizationSchema.properties.id,
    cloudOrganizationName: client.createCloudOrganizationRequestSchema.properties.name,
    cloudStoredState: cloudStoredStateSchema,
    cloudStoredValue: database.cloudStoredValueSchema,
    cloudSession: database.cloudSessionSchema,
    cloudVersion: cloudVersionSchema,
    cloudAuthorizationExpiry: cloudAuthorizationExpiryArgumentsSchema,
    cloudSessionRefresh: cloudSessionRefreshArgumentsSchema,
    cloudAuthorizationSecret: workos.authorizationSchema,
    cloudAuthentication: workos.workosAuthenticationSchema,
    // Actual WorkOS SDK wire spelling before its camelCase projection. Reuse
    // the Source validation fields so neither native parsing nor mapping widens it.
    cloudAuthenticationWire: Type.Object(
        {
            access_token: workos.workosAuthenticationSchema.properties.accessToken,
            refresh_token: workos.workosAuthenticationSchema.properties.refreshToken,
            user: Type.Object(
                {
                    email: user.email,
                    first_name: user.firstName,
                    id: user.id,
                    last_name: user.lastName,
                },
                { additionalProperties: true },
            ),
        },
        { additionalProperties: true },
    ),
    cloudOAuthError: Type.Object(
        { error: Type.String(), error_description: Type.Optional(Type.String()) },
        { additionalProperties: true },
    ),
    cloudHello: workos.helloSchema,
    cloudRemoteOrganizations: workos.cloudOrganizationsResponseSchema,
    cloudRemoteTeam: workos.remoteHappyTeamSchema,
    cloudRemoteTeams: workos.happyTeamsResponseSchema,
    cloudInvalidOrganization: workos.invalidOrganizationSchema,
    cloudOrganizationForbidden: workos.organizationForbiddenSchema,
    cloudInvalidEndpoint: workos.invalidOrganizationEndpointSchema,
    cloudEndpointResponse: workos.organizationEndpointResponseSchema,
    cloudOrganizationNotFound: workos.organizationNotFoundSchema,
    cloudOrganizationDeleted: workos.organizationDeletedSchema,
    cloudInvitationResponse: workos.invitationResponseSchema,
    cloudInvitationConflict: workos.invitationConflictSchema,
    cloudOrganizationClaims: organization.claimsSchema,
    cloudShortLivedClaims: short.claimsSchema,
    cloudShortLivedToken: shortLivedWorkOSTokenSchema,
    cloudTeam: happyTeamSchema,
    cloudTeamEndpointInput: happyTeamEndpointInputSchema,
    cloudTeamEndpoint: happyTeamEndpointSchema,
    cloudInvitationOrganization: happyTeamInvitationOrganizationIdSchema,
    cloudInvitationEmailInput: happyTeamInvitationEmailInputSchema,
    cloudInvitationEmail: invitation.invitationEmailSchema,
    cloudInvitation: happyTeamInvitationSchema,
    cloudDeployment: Type.Object(
        {
            cloudUrl: Type.String({ minLength: 1, maxLength: 2048 }),
            workosUrl: Type.String({ minLength: 1, maxLength: 2048 }),
            workosClientId: Type.String({ minLength: 1, maxLength: 256 }),
        },
        exact,
    ),
};
