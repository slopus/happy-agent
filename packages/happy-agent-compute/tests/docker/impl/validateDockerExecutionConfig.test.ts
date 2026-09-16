import { describe, expect, it } from "vitest";

import { validateDockerExecutionConfig } from "../../../sources/docker/impl/validateDockerExecutionConfig.js";

describe("validateDockerExecutionConfig", () => {
    it("accepts an administrator-installed AppArmor profile only for managed containers", () => {
        expect(() =>
            validateDockerExecutionConfig({
                image: "dev:local",
                workingDirectory: "/workspace",
                apparmorProfile: "happy-compute-tests",
            }),
        ).not.toThrow();
        for (const apparmorProfile of ["", "bad\nprofile", "a".repeat(129)]) {
            expect(() =>
                validateDockerExecutionConfig({
                    image: "dev:local",
                    workingDirectory: "/workspace",
                    apparmorProfile,
                }),
            ).toThrow("Docker environment settings are not valid");
        }
        expect(() =>
            validateDockerExecutionConfig({
                container: "dev",
                workingDirectory: "/workspace",
                apparmorProfile: "happy-compute-tests",
            }),
        ).toThrow("Docker environment settings are not valid");
    });

    it("requires exactly one of a container or an image", () => {
        expect(() => validateDockerExecutionConfig({ workingDirectory: "/workspace" })).toThrow(
            "Docker environment settings are not valid",
        );
        expect(() =>
            validateDockerExecutionConfig({
                container: "dev",
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
    });

    it("requires an absolute working directory", () => {
        expect(() =>
            validateDockerExecutionConfig({ image: "dev:local", workingDirectory: "workspace" }),
        ).toThrow("Docker environment settings are not valid");
    });

    it("rejects mounts or environment paired with an existing container", () => {
        expect(() =>
            validateDockerExecutionConfig({
                container: "dev",
                mounts: [{ source: "/a", target: "/b" }],
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
    });

    it("rejects malformed mount entries with a human-readable error", () => {
        expect(() =>
            validateDockerExecutionConfig({
                image: "dev:local",
                mounts: [null],
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
    });

    it("allows host mount sources that will be resolved relative to the session cwd", () => {
        expect(() =>
            validateDockerExecutionConfig({
                image: "dev:local",
                mounts: [{ source: ".", target: "/workspace" }],
                workingDirectory: "/workspace",
            }),
        ).not.toThrow();
    });

    it("accepts Linux supervisor architectures for emulated images", () => {
        expect(() =>
            validateDockerExecutionConfig({
                architecture: "amd64",
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).not.toThrow();
        expect(() =>
            validateDockerExecutionConfig({
                architecture: "mips64",
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
    });

    it("validates the optional host policy as data", () => {
        expect(() =>
            validateDockerExecutionConfig({
                hostPolicy: {
                    networkPolicyFiles: ["access.conf"],
                    privateDirectories: ["/product/private"],
                    privatePathVariables: ["PRODUCT_PRIVATE_ROOT"],
                    protectedProjectFiles: ["product.policy"],
                    readableDirectories: ["/product/docs"],
                },
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).not.toThrow();
        expect(() =>
            validateDockerExecutionConfig({
                hostPolicy: { privateDirectories: [42] },
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
        expect(() =>
            validateDockerExecutionConfig({
                hostPolicy: { privateDirectories: ["relative/private"] },
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
        expect(() =>
            validateDockerExecutionConfig({
                hostPolicy: { unknownPaths: ["/private"] },
                image: "dev:local",
                workingDirectory: "/workspace",
            }),
        ).toThrow("Docker environment settings are not valid");
    });
});
