import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const packageVersionModule = "@slopus/rig/package-version";
const require = createRequire(import.meta.url);

describe("published modules", () => {
    it("exports Happy's Rig wire contracts as types", async () => {
        await execFileAsync("pnpm", ["run", "build"], { cwd: packageDirectory });

        await Promise.all(
            ["types", "readPackageVersion"].map((modulePath) =>
                access(fileURLToPath(new URL(`../dist/${modulePath}.d.ts`, import.meta.url))),
            ),
        );
        await access(fileURLToPath(new URL("../dist/readPackageVersion.js", import.meta.url)));

        const consumerDirectory = await mkdtemp(join(packageDirectory, ".published-types-"));
        const consumerPath = join(consumerDirectory, "consumer.ts");
        try {
            await writeFile(
                consumerPath,
                `import type {
    AttachSecretRequest,
    ChangeEffortRequest,
    ChangePermissionModeRequest,
    CreateRemoteTerminalRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    GetDaemonConfigResponse,
    HealthResponse,
    ListModelsResponse,
    ListSecretsResponse,
    ListSubagentsResponse,
    ModelCatalog,
    ProtocolSession,
    RegisterSecretRequest,
    RegisterSecretResponse,
    RemoteTerminalResponse,
    RemoteTerminalSummary,
    SecretSummary,
    SubmitMessageRequest,
    SubmitMessageResponse,
    SubagentSummary,
    TrimGlobalEventsRequest,
    UnregisterSecretResponse,
    UpdateDaemonConfigRequest,
} from "@slopus/rig/types";
import type { ProtocolSession as LegacyProtocolSession } from "@slopus/rig/dist/protocol/index.js";
import type { RemoteTerminalSummary as LegacyRemoteTerminalSummary } from "@slopus/rig/dist/terminal/index.js";

export type RigTypes = [
    AttachSecretRequest,
    ChangeEffortRequest,
    ChangePermissionModeRequest,
    CreateRemoteTerminalRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    GetDaemonConfigResponse,
    HealthResponse,
    ListModelsResponse,
    ListSecretsResponse,
    ListSubagentsResponse,
    ModelCatalog,
    ProtocolSession,
    RegisterSecretRequest,
    RegisterSecretResponse,
    RemoteTerminalResponse,
    RemoteTerminalSummary,
    SecretSummary,
    SubmitMessageRequest,
    SubmitMessageResponse,
    SubagentSummary,
    TrimGlobalEventsRequest,
    UnregisterSecretResponse,
    UpdateDaemonConfigRequest,
    LegacyProtocolSession,
    LegacyRemoteTerminalSummary,
];
`,
            );
            const program = ts.createProgram([consumerPath], {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                noEmit: true,
                skipLibCheck: true,
                strict: true,
                target: ts.ScriptTarget.ES2023,
            });
            const diagnostics = ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
            expect(diagnostics).toEqual([]);
        } finally {
            await rm(consumerDirectory, { force: true, recursive: true });
        }

        const manifest = JSON.parse(
            await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
        ) as { version: string };
        const version = (await import(packageVersionModule)) as {
            readPackageVersion(): string;
        };
        expect(version.readPackageVersion()).toBe(manifest.version);
        expect(require.resolve("@slopus/rig/dist/main.js")).toBe(
            fileURLToPath(new URL("../dist/main.js", import.meta.url)),
        );
    }, 30_000);
});
