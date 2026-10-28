import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { awsProfileRoutes } from "../../sources/providerRoutes/impl/awsProfileRoutes.js";

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true })));
});

/** A throwaway home with a fake AWS config file, and a credentials file that must stay unread. */
async function machine(config: string) {
    const home = await mkdtemp(join(tmpdir(), "aws-"));
    homes.push(home);
    await mkdir(join(home, ".aws"));
    await writeFile(join(home, ".aws", "config"), config);
    // Unreadable on purpose: detection that opened it would throw instead of returning routes.
    await mkdir(join(home, ".aws", "credentials"));
    return { platform: process.platform, env: { HOME: home }, programDirectories: [] };
}

const CONFIG = `
[default]
region = us-east-1

[profile work-bedrock]
credential_process = /usr/local/bin/helper --format aws
region = us-west-2

; A single sign-on profile, whose session only AWS can vouch for.
[profile sso-dev]
sso_session = corp
sso_account_id = 123456789012
region = eu-west-1

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start

[services local]
bedrock-runtime =
  endpoint_url = http://localhost:9999
`;

describe("AWS profiles for Bedrock", () => {
    it("offers each named profile by name and region, without reading a secret or asking AWS", async () => {
        const routes = await awsProfileRoutes(
            await machine(CONFIG),
            { providerId: "bedrock", available: true },
            () => undefined,
        );

        expect(routes.map((route) => [route.id, route.status, route.providerId])).toEqual([
            ["bedrock", "ready", "bedrock"],
            ["aws_profile:work-bedrock", "ready", undefined],
            ["aws_profile:sso-dev", "unknown", undefined],
        ]);
        expect(routes[1]).toMatchObject({
            kind: "cloud",
            name: "AWS profile work-bedrock",
            vendors: ["Amazon Bedrock"],
            billing: "pay_per_token",
            provider: {
                id: "bedrock_work_bedrock",
                table: {
                    type: "bedrock",
                    name: "Bedrock (work-bedrock)",
                    profile: "work-bedrock",
                    region: "us-west-2",
                },
            },
        });
        expect(JSON.stringify(routes)).not.toContain("helper");
    });

    it("keeps the default profile when there is no built-in Bedrock, and knows a configured profile", async () => {
        const routes = await awsProfileRoutes(await machine(CONFIG), null, (profile) =>
            profile === "work-bedrock" ? "west_bedrock" : undefined,
        );
        expect(routes.map((route) => route.id)).toEqual([
            "aws_profile:default",
            "aws_profile:work-bedrock",
            "aws_profile:sso-dev",
        ]);
        expect(routes[1]).toMatchObject({ provider: { id: "west_bedrock" } });
        expect(routes[2]).toMatchObject({ provider: { id: "bedrock_sso_dev" } });
    });

    it("finds nothing without an AWS config file", async () => {
        const home = await mkdtemp(join(tmpdir(), "aws-"));
        homes.push(home);
        await expect(
            awsProfileRoutes(
                { platform: process.platform, env: { HOME: home }, programDirectories: [] },
                { providerId: "bedrock", available: false },
                () => undefined,
            ),
        ).resolves.toEqual([]);
    });
});
