import { fileURLToPath } from "node:url";

import type { ReleasePackage, ReleasePackageKey } from "./ReleasePackage.js";

const PACKAGES: Record<ReleasePackageKey, ReleasePackage> = {
    "happy-agent-base": {
        buildArguments: ["--filter", "@slopus/happy-agent-base", "build"],
        checkArguments: ["--filter", "@slopus/happy-agent-base", "check"],
        commitPrefix: "Release happy-agent-base v",
        directory: fileURLToPath(new URL("../../packages/happy-agent-base/", import.meta.url)),
        key: "happy-agent-base",
        manifestPath: "packages/happy-agent-base/package.json",
        tagPrefix: "happy-agent-base-v",
        testArguments: [["--filter", "@slopus/happy-agent-base", "test"]],
    },
    "happy-agent-client": {
        buildArguments: ["--filter", "@slopus/happy-agent-client", "build"],
        checkArguments: ["--filter", "@slopus/happy-agent-client", "check"],
        commitPrefix: "Release happy-agent-client v",
        directory: fileURLToPath(new URL("../../packages/happy-agent-client/", import.meta.url)),
        key: "happy-agent-client",
        manifestPath: "packages/happy-agent-client/package.json",
        tagPrefix: "happy-agent-client-v",
        testArguments: [["--filter", "@slopus/happy-agent-client", "test"]],
    },
    "happy-agent-compute": {
        buildArguments: ["--filter", "@slopus/happy-agent-compute", "build"],
        checkArguments: ["--filter", "@slopus/happy-agent-compute", "check"],
        commitPrefix: "Release happy-agent-compute v",
        directory: fileURLToPath(new URL("../../packages/happy-agent-compute/", import.meta.url)),
        key: "happy-agent-compute",
        manifestPath: "packages/happy-agent-compute/package.json",
        tagPrefix: "happy-agent-compute-v",
        testArguments: [["--filter", "@slopus/happy-agent-compute", "test"]],
    },
    "happy-providers": {
        buildArguments: ["--filter", "@slopus/happy-providers", "build"],
        checkArguments: ["--filter", "@slopus/happy-providers", "check"],
        commitPrefix: "Release happy-providers v",
        directory: fileURLToPath(new URL("../../packages/happy-providers/", import.meta.url)),
        key: "happy-providers",
        manifestPath: "packages/happy-providers/package.json",
        tagPrefix: "happy-providers-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "@slopus/happy-providers", "test"],
        ],
    },
    "happy-plugins": {
        buildArguments: ["--filter", "happy-plugins", "build"],
        checkArguments: ["--filter", "happy-plugins", "check"],
        commitPrefix: "Release happy-plugins v",
        directory: fileURLToPath(new URL("../../packages/happy-plugins/", import.meta.url)),
        key: "happy-plugins",
        manifestPath: "packages/happy-plugins/package.json",
        tagPrefix: "happy-plugins-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "happy-plugins", "test"],
        ],
    },
    "happy-terminal": {
        buildArguments: ["run", "build"],
        checkArguments: ["run", "check"],
        commitPrefix: "Release Happy Terminal v",
        directory: fileURLToPath(new URL("../../packages/happy-terminal/", import.meta.url)),
        key: "happy-terminal",
        manifestPath: "packages/happy-terminal/package.json",
        tagPrefix: "happy-terminal-v",
        testArguments: [["run", "test:release"]],
    },
};

export function resolveReleasePackage(value: string | undefined): ReleasePackage {
    const key = value ?? "happy-terminal";
    if (
        key !== "happy-terminal" &&
        key !== "happy-agent-base" &&
        key !== "happy-agent-client" &&
        key !== "happy-agent-compute" &&
        key !== "happy-plugins" &&
        key !== "happy-providers"
    ) {
        throw new Error(
            `Unknown release package ${key}. Expected happy-terminal, happy-agent-base, happy-agent-client, happy-agent-compute, happy-plugins, or happy-providers.`,
        );
    }
    return PACKAGES[key];
}
