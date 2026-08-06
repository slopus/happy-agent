import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    happyComputeErrorSchema,
    happyComputeInstanceSchema,
    happyComputePreparationEventSchema,
} from "../sources/computeTypes.js";
import { createWorkspaceInputSchema, happyPluginManifestSchema } from "../sources/types.js";
import { HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS } from "../sources/types.js";

describe("happy plugin manifest", () => {
    it("accepts a stable identity for idempotent workspace creation", () => {
        expect(
            Value.Check(createWorkspaceInputSchema, {
                id: "g1l4nup1ppbrfvae0pllq6ul",
                name: "Queued work",
                projectId: "project-id",
            }),
        ).toBe(true);
        expect(
            Value.Check(createWorkspaceInputSchema, {
                id: "stable-id-for-a-retry",
                name: "Queued work",
                projectId: "project-id",
            }),
        ).toBe(false);
    });

    it("requires bounded catalog author and category metadata", () => {
        const manifest = {
            author: "Happy",
            category: "developer-tools",
            description: "Tests catalog metadata.",
            icon: "icon.png",
            main: "index.ts",
            name: "Catalog fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, manifest)).toBe(true);
        expect(Value.Check(happyPluginManifestSchema, { ...manifest, author: "" })).toBe(false);
        expect(
            Value.Check(happyPluginManifestSchema, { ...manifest, author: "x".repeat(81) }),
        ).toBe(false);
        for (const author of ["Happy\u0085Tools", "Happy\u202eTools", "Happy\u2066Tools"]) {
            expect(Value.Check(happyPluginManifestSchema, { ...manifest, author })).toBe(false);
        }
        expect(
            Value.Check(happyPluginManifestSchema, { ...manifest, category: "uncategorized" }),
        ).toBe(false);
        const { author: _author, ...withoutAuthor } = manifest;
        const { category: _category, ...withoutCategory } = manifest;
        expect(Value.Check(happyPluginManifestSchema, withoutAuthor)).toBe(false);
        expect(Value.Check(happyPluginManifestSchema, withoutCategory)).toBe(false);
    });

    it("validates compute readiness errors and terminal instance tombstones", () => {
        expect(
            Value.Check(happyComputeErrorSchema, {
                code: "preparing_compute",
                message: "The instance is still provisioning.",
                retryable: true,
                state: "provisioning",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputeErrorSchema, {
                code: "preparing_compute",
                message: "The instance failed.",
                retryable: true,
                state: "failed",
            }),
        ).toBe(false);
        expect(
            Value.Check(happyComputeInstanceSchema, {
                createdAt: 10,
                diedAt: 20,
                instanceId: "instance-1",
                provider: "test-compute",
                reason: "The provider crashed.",
                state: "failed",
            }),
        ).toBe(true);
    });

    it("validates typed compute preparation events", () => {
        expect(
            Value.Check(happyComputePreparationEventSchema, {
                createdAt: 10,
                error: {
                    code: "preparing_compute",
                    message: "The sandbox API rejected provisioning.",
                    retryable: true,
                    state: "unprovisioned",
                },
                instanceId: "instance-1",
                message: "The sandbox API rejected provisioning.",
                phase: "failed",
                provider: "test-compute",
                state: "unprovisioned",
                type: "compute_preparation",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputePreparationEventSchema, {
                createdAt: 20,
                error: {
                    code: "instance_failed",
                    message: "The compute provider disconnected.",
                    retryable: false,
                    state: "failed",
                },
                instanceId: "instance-1",
                message: "The compute provider disconnected.",
                phase: "failed",
                provider: "test-compute",
                state: "failed",
                type: "compute_preparation",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputePreparationEventSchema, {
                createdAt: 30,
                error: {
                    code: "preparing_compute",
                    message: "The compute provider is recovering.",
                    retryable: true,
                    state: "unavailable",
                },
                instanceId: "instance-1",
                message: "The compute provider is recovering.",
                phase: "preparing_compute",
                provider: "test-compute",
                state: "unavailable",
                type: "compute_preparation",
            }),
        ).toBe(true);
    });

    it("accepts Dockerfile and prebuilt-image runtime declarations", () => {
        const manifest = {
            author: "Happy",
            category: "developer-tools",
            description: "Runs in a container.",
            icon: "icon.png",
            main: "index.ts",
            name: "Docker fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, { ...manifest, docker: true })).toBe(true);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                docker: { image: "registry.example.com/plugins/fixture:1.0.0" },
            }),
        ).toBe(true);
        expect(Value.Check(happyPluginManifestSchema, { ...manifest, docker: false })).toBe(false);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                docker: { image: "invalid image", pull: true },
            }),
        ).toBe(false);
    });

    it("matches entry point extensions case-insensitively and rejects declarations", () => {
        const manifest = {
            author: "Happy",
            category: "developer-tools",
            description: "Tests the manifest entry point.",
            icon: "icon.png",
            main: "index.MJS",
            name: "Manifest fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, manifest)).toBe(true);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                main: "index.d.Ts",
            }),
        ).toBe(false);
    });

    it("accepts at most sixteen exact interception hostnames and rejects wildcards", () => {
        const manifest = {
            author: "Happy",
            category: "developer-tools",
            description: "Intercepts one exact API host.",
            icon: "icon.png",
            interceptDomains: ["api.example.com"],
            main: "index.ts",
            name: "Network fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, manifest)).toBe(true);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                interceptDomains: ["*.example.com"],
            }),
        ).toBe(false);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                interceptDomains: Array.from(
                    { length: HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS + 1 },
                    (_, index) => `api-${String(index)}.example.com`,
                ),
            }),
        ).toBe(false);
    });
});
