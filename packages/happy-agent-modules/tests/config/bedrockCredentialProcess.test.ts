import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnthropicProvider, CodexProvider } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("Bedrock credential_process configuration", () => {
    it("loads one AWS profile for both OpenAI and Anthropic Bedrock models", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bedrock-config-"));
        temporaryDirectories.push(root);
        const awsHome = join(root, "aws");
        const configFile = join(awsHome, "config");
        const credentialsFile = join(awsHome, "credentials");
        const credentialProcess = join(awsHome, "credentials.mjs");
        const happyConfigHome = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
        );
        await mkdir(awsHome, { recursive: true });
        await mkdir(happyConfigHome, { recursive: true });
        await writeFile(
            credentialProcess,
            `console.log(JSON.stringify(${JSON.stringify({
                AccessKeyId: "CONFIG_PROCESS_ACCESS_KEY",
                Expiration: "2099-01-01T00:00:00.000Z",
                SecretAccessKey: "config-process-secret",
                SessionToken: "config-process-session",
                Version: 1,
            })}));\n`,
        );
        await writeFile(
            configFile,
            `[profile work-bedrock]\ncredential_process = ${shellArgument(process.execPath)} ${shellArgument(credentialProcess)}\n`,
        );
        await writeFile(credentialsFile, "");
        await writeFile(
            join(happyConfigHome, "happy.toml"),
            [
                "[providers]",
                "default_enable = false",
                "",
                "[providers.bedrock]",
                "enabled = true",
                `profile = ${tomlString("work-bedrock")}`,
                `config_file = ${tomlString(configFile)}`,
                `credentials_file = ${tomlString(credentialsFile)}`,
                'region = "us-west-2"',
            ].join("\n"),
        );

        const config = await ConfigModule.load(join(root, ".happy"));
        const openai = await config.providers.resolve("bedrock", "openai/gpt-5.6-sol");
        const anthropic = await config.providers.resolve("bedrock", "anthropic/sonnet-5");

        expect(openai).toBeInstanceOf(CodexProvider);
        expect(anthropic).toBeInstanceOf(AnthropicProvider);
        if (!(openai instanceof CodexProvider) || !(anthropic instanceof AnthropicProvider)) {
            throw new Error("Expected both Bedrock provider families.");
        }
        expect(openai.credential.name).toBe("bedrock-aws");
        expect(anthropic.credential.name).toBe("bedrock-aws");
        if (openai.credential.name !== "bedrock-aws") {
            throw new Error("Expected an AWS Bedrock credential.");
        }
        await expect(openai.credential.credential.provider()).resolves.toMatchObject({
            accessKeyId: "CONFIG_PROCESS_ACCESS_KEY",
            sessionToken: "config-process-session",
        });
    });
});

function shellArgument(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}
