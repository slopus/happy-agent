import { createHash } from "node:crypto";

import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import type { AssetStore } from "../../sources/imageGeneration/AssetStore.js";
import {
    MAX_IMAGE_ID_CHARACTERS,
    MAX_IMAGE_LOCATOR_CHARACTERS,
    imageAssetSchema,
    imageFingerprintSchema,
    imageGenerationReceiptSchema,
    imageGenerationStatusSchema,
    type ImageAsset,
    type ImageGenerationInput,
    type ImageGenerationProof,
    type ImageGenerationReceipt,
    type ImageGenerationStage,
    type ImageGenerationStageInput,
    type ImageGenerationStatus,
} from "../../sources/imageGeneration/ImageGeneration.js";
import {
    ImageGenerationFeature,
    imageGenerationFeatureOptionsSchema,
} from "../../sources/imageGeneration/ImageGenerationFeature.js";
import type { ImageGenerationEvent } from "../../sources/imageGeneration/ImageGenerationEvent.js";
import type {
    GeneratedImage,
    ImageGenerator,
    ImageGeneratorRequest,
} from "../../sources/imageGeneration/ImageGenerator.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

const root = createRootContext().named("image-generation-tests");

class HostImageStore {
    readonly operations = new Map<string, ImageGenerationStatus>();
    readonly assets = new Map<string, ImageAsset>();
    readonly receipts = new Map<string, ImageGenerationReceipt>();
    readonly generationProofs = new Map<string, ImageGenerationProof>();
    readonly staged = new Map<string, ImageGenerationStage>();
    readonly callbacks: Array<(ctx: Context) => void | Promise<void>> = [];
    readonly rollbackCallbacks: Array<(ctx: Context) => void | Promise<void>> = [];
    readonly contract: AssetStore;
    #stageCounter = 0;

    constructor() {
        this.contract = {
            transaction: this.transaction.bind(this),
            afterCommit: this.afterCommit.bind(this),
            onRollback: this.onRollback.bind(this),
            stage: this.stage.bind(this),
            commit: this.commit.bind(this),
            rollback: this.rollback.bind(this),
            create: this.create.bind(this),
            status: this.status.bind(this),
            read: this.read.bind(this),
            remove: this.remove.bind(this),
            readReceipt: this.readReceipt.bind(this),
            writeReceipt: this.writeReceipt.bind(this),
            readGenerationProof: this.readGenerationProof.bind(this),
            writeGenerationProof: this.writeGenerationProof.bind(this),
        };
    }

    async transaction<Result>(
        _ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        const operations = cloneMap(this.operations);
        const assets = cloneMap(this.assets);
        const receipts = cloneMap(this.receipts);
        const generationProofs = cloneMap(this.generationProofs);
        const callbackCount = this.callbacks.length;
        const rollbackCount = this.rollbackCallbacks.length;
        try {
            return await work(root);
        } catch (error: unknown) {
            restoreMap(this.operations, operations);
            restoreMap(this.assets, assets);
            restoreMap(this.receipts, receipts);
            restoreMap(this.generationProofs, generationProofs);
            this.callbacks.splice(callbackCount);
            const rollback = this.rollbackCallbacks.splice(rollbackCount);
            for (const callback of rollback) await callback(root);
            throw error;
        }
    }

    afterCommit(_ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        this.callbacks.push(callback);
    }

    onRollback(_ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        this.rollbackCallbacks.push(callback);
    }

    async stage(_ctx: Context, input: ImageGenerationStageInput): Promise<ImageGenerationStage> {
        const stage: ImageGenerationStage = {
            stageId: `stage-${++this.#stageCounter}`,
            agentId: input.agentId,
            operationId: input.operationId,
            fingerprint: input.fingerprint,
            mediaType: input.mediaType,
            byteLength: input.bytes.byteLength,
            ...(input.width === undefined ? {} : { width: input.width }),
            ...(input.height === undefined ? {} : { height: input.height }),
            ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
        };
        this.staged.set(stage.stageId, structuredClone(stage));
        return structuredClone(stage);
    }

    async commit(_ctx: Context, stage: ImageGenerationStage): Promise<void> {
        this.staged.delete(stage.stageId);
    }

    async rollback(_ctx: Context, stage: ImageGenerationStage): Promise<void> {
        this.staged.delete(stage.stageId);
    }

    async create(
        _ctx: Context,
        input: AssetStore extends never ? never : Parameters<AssetStore["create"]>[1],
    ): Promise<ImageGenerationStatus> {
        const stage = this.staged.get(input.stage.stageId);
        if (stage === undefined) throw new Error("missing stage");
        const asset: ImageAsset = {
            id: `asset-${input.operationId}`,
            agentId: input.agentId,
            operationId: input.operationId,
            mediaType: stage.mediaType,
            byteLength: stage.byteLength,
            locator: `asset://${input.operationId}`,
            ...(stage.width === undefined ? {} : { width: stage.width }),
            ...(stage.height === undefined ? {} : { height: stage.height }),
            ...(stage.metadata === undefined ? {} : { metadata: structuredClone(stage.metadata) }),
        };
        const status: ImageGenerationStatus = {
            operationId: input.operationId,
            agentId: input.agentId,
            fingerprint: input.fingerprint,
            prompt: input.prompt,
            ...(input.options === undefined ? {} : { options: structuredClone(input.options) }),
            status: "completed",
            createdAt: 100,
            updatedAt: 100,
            asset,
        };
        this.operations.set(input.operationId, structuredClone(status));
        this.assets.set(asset.id, structuredClone(asset));
        return structuredClone(status);
    }

    async status(
        _ctx: Context,
        query: Parameters<AssetStore["status"]>[1],
    ): Promise<ImageGenerationStatus | undefined> {
        const value = this.operations.get(query.operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    async read(
        _ctx: Context,
        query: Parameters<AssetStore["read"]>[1],
    ): Promise<ImageAsset | undefined> {
        const value = this.assets.get(query.assetId);
        return value === undefined ? undefined : structuredClone(value);
    }

    async remove(_ctx: Context, query: Parameters<AssetStore["remove"]>[1]): Promise<boolean> {
        const asset = this.assets.get(query.assetId);
        if (asset === undefined) return false;
        if (asset.agentId !== query.agentId) return false;
        this.assets.delete(query.assetId);
        this.operations.delete(asset.operationId);
        return true;
    }

    async readReceipt(
        _ctx: Context,
        query: Parameters<AssetStore["readReceipt"]>[1],
    ): Promise<ImageGenerationReceipt | undefined> {
        const value = this.receipts.get(query.operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    async writeReceipt(_ctx: Context, receipt: ImageGenerationReceipt): Promise<void> {
        this.receipts.set(receipt.operationId, structuredClone(receipt));
    }

    async readGenerationProof(
        _ctx: Context,
        query: Parameters<AssetStore["readGenerationProof"]>[1],
    ): Promise<ImageGenerationProof | undefined> {
        const value = this.generationProofs.get(query.operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    async writeGenerationProof(_ctx: Context, proof: ImageGenerationProof): Promise<void> {
        const existing = this.generationProofs.get(proof.operationId);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(proof)) {
            throw new Error("immutable generation proof replacement");
        }
        this.generationProofs.set(proof.operationId, structuredClone(proof));
    }

    async flushCommit(): Promise<void> {
        const callback = this.callbacks.shift();
        if (callback === undefined) throw new Error("no post-commit callback");
        await callback(root);
    }

    async flushRollback(): Promise<void> {
        const callback = this.rollbackCallbacks.shift();
        if (callback === undefined) throw new Error("no rollback callback");
        await callback(root);
    }
}

function cloneMap<Value>(source: Map<string, Value>): Map<string, Value> {
    return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function restoreMap<Value>(target: Map<string, Value>, source: Map<string, Value>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, structuredClone(value));
}

function generator(
    output: GeneratedImage = {
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        width: 32,
        height: 32,
        metadata: { provider: "test" },
    },
): { readonly generator: ImageGenerator; readonly generate: ReturnType<typeof vi.fn> } {
    const generate = vi.fn().mockResolvedValue(output);
    return { generator: { generate }, generate };
}

function feature(
    host: HostImageStore,
    service: ImageGenerator,
    overrides: Partial<ConstructorParameters<typeof ImageGenerationFeature>[0]> = {},
): ImageGenerationFeature {
    return new ImageGenerationFeature({
        generator: service,
        store: host.contract,
        idFactory: async () => "operation-1",
        eventIdFactory: async (_ctx, _agentId, operationId) => `event-${operationId}`,
        clock: () => 100,
        ...overrides,
    });
}

describe("ImageGenerationFeature", () => {
    it("uses one public implementation for the durable common tool and replays by call-scoped KV", async () => {
        const host = new HostImageStore();
        const generated = generator();
        const images = feature(host, generated.generator);
        const tool = images.tools(root, { agent: { id: "agent-1" } } as never)[0]!;
        const toolCtx = withAgentKV(root, new AgentKV(new InMemoryPersistence(), "call."));

        const first = await tool.execute(toolCtx, { prompt: "  A blue moon  " });
        const replay = await tool.execute(toolCtx, { prompt: "A blue moon" });

        expect(first).toEqual(replay);
        expect(generated.generate).toHaveBeenCalledOnce();
        expect(host.assets.size).toBe(1);
        expect(tool.name).toBe("generate_image");
        expect(tool.durable).toBe(true);
        expect(Value.Check(tool.parameters!, { prompt: "A prompt", operationId: "model-id" })).toBe(
            false,
        );
        expect(images.formatForModel(first)).toContain("Asset ID: asset-operation-1");
    });

    it("detaches the generator request so host mutation cannot escape normalized state or replay", async () => {
        const host = new HostImageStore();
        const requests: ImageGeneratorRequest[] = [];
        const generatedOutput: GeneratedImage = {
            bytes: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
        };
        const generate = vi.fn(async (_ctx: Context, request: ImageGeneratorRequest) => {
            requests.push(request);
            request.options!.style = "host-mutated";
            return structuredClone(generatedOutput);
        });
        const images = feature(host, { generate });
        const input: ImageGenerationInput = {
            operationId: "operation-generator-request",
            prompt: "A mountain",
            options: { style: "original" },
        };

        const first = await images.generate(root, "agent-1", input);
        expect(first.options).toEqual({ style: "original" });
        expect(host.operations.get(input.operationId!)).toMatchObject({
            options: { style: "original" },
        });
        expect(input.options).toEqual({ style: "original" });
        expect(requests[0]?.options).toEqual({ style: "host-mutated" });

        await host.flushCommit();
        await expect(images.generate(root, "agent-1", input)).resolves.toEqual(first);
        expect(generate).toHaveBeenCalledOnce();
        expect(input.options).toEqual({ style: "original" });
        expect(host.operations.get(input.operationId!)).toMatchObject({
            options: { style: "original" },
        });
    });

    it("replays an authoritative receipt after a fresh feature instance and enforces owner identity", async () => {
        const host = new HostImageStore();
        const firstGenerator = generator();
        const first = feature(host, firstGenerator.generator);
        const input: ImageGenerationInput = {
            operationId: "operation-replay",
            prompt: "A house",
        };
        const created = await first.generate(root, "agent-1", input);
        await host.flushCommit();

        const secondGenerator = generator();
        const reloaded = feature(host, secondGenerator.generator);
        expect(await reloaded.generate(root, "agent-1", input)).toEqual(created);
        expect(secondGenerator.generate).not.toHaveBeenCalled();
        expect(await reloaded.status(root, "agent-1", "operation-replay")).toEqual(created);
        expect(await reloaded.read(root, "agent-1", "asset-operation-replay")).toEqual(
            created.status === "completed" ? created.asset : undefined,
        );
        await expect(reloaded.status(root, "agent-2", "operation-replay")).rejects.toThrow(
            "different operation identity",
        );
    });

    it("round-trips a worst-case escaped prompt through the receipt and proof", async () => {
        const host = new HostImageStore();
        const firstGenerator = generator();
        const first = feature(host, firstGenerator.generator);
        const input: ImageGenerationInput = {
            operationId: "operation-worst-case-prompt",
            prompt: "\0".repeat(8_000),
        };

        const original = await first.generate(root, "agent-1", input);
        await host.flushCommit();

        const receipt = host.receipts.get(input.operationId!);
        const proof = host.generationProofs.get(input.operationId!);
        expect(receipt?.prompt).toBe(input.prompt);
        expect(proof?.prompt).toBe(input.prompt);
        expect(proof).toEqual(receipt);

        const replayGenerator = generator();
        const fresh = feature(host, replayGenerator.generator);
        await expect(fresh.generate(root, "agent-1", input)).resolves.toEqual(original);
        expect(replayGenerator.generate).not.toHaveBeenCalled();
    });

    it("replays the immutable generation proof after asset removal without mutable state recreation", async () => {
        const host = new HostImageStore();
        const firstGenerated = generator();
        const events: ImageGenerationEvent[] = [];
        const first = feature(host, firstGenerated.generator, {
            listener: {
                onEvent: async (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        const input: ImageGenerationInput = {
            operationId: "operation-tombstone",
            prompt: "A lighthouse",
        };

        const original = await first.generate(root, "agent-1", input);
        await host.flushCommit();
        expect(host.generationProofs.get(input.operationId!)).toBeDefined();
        const removed = await first.remove(root, "agent-1", "asset-operation-tombstone");
        expect(removed).toBe(true);
        await host.flushCommit();
        expect(host.operations.size).toBe(0);
        expect(host.assets.size).toBe(0);
        expect(host.receipts.size).toBe(1);
        expect(host.generationProofs.size).toBe(1);
        expect(events).toHaveLength(2);

        const mutationCalls = {
            stage: vi.spyOn(host.contract, "stage"),
            create: vi.spyOn(host.contract, "create"),
            status: vi.spyOn(host.contract, "status"),
            read: vi.spyOn(host.contract, "read"),
            writeReceipt: vi.spyOn(host.contract, "writeReceipt"),
            writeGenerationProof: vi.spyOn(host.contract, "writeGenerationProof"),
        };
        const countsBeforeReplay = Object.fromEntries(
            Object.entries(mutationCalls).map(([name, spy]) => [name, spy.mock.calls.length]),
        );
        const replayEvents: ImageGenerationEvent[] = [];
        const secondGenerated = generator();
        const fresh = feature(host, secondGenerated.generator, {
            listener: {
                onEvent: async (_ctx, event) => {
                    replayEvents.push(event);
                },
            },
        });

        await expect(fresh.generate(root, "agent-1", input)).resolves.toEqual(original);
        expect(secondGenerated.generate).not.toHaveBeenCalled();
        for (const [name, spy] of Object.entries(mutationCalls)) {
            expect(spy.mock.calls.length, name).toBe(countsBeforeReplay[name]);
        }
        expect(replayEvents).toHaveLength(0);
        expect(host.operations.size).toBe(0);
        expect(host.assets.size).toBe(0);
    });

    it("fails closed for dangling, missing, or tampered generation proofs", async () => {
        const prepare = async (): Promise<{
            readonly host: HostImageStore;
            readonly input: ImageGenerationInput;
        }> => {
            const host = new HostImageStore();
            const input: ImageGenerationInput = {
                operationId: "operation-proof-integrity",
                prompt: "A red planet",
            };
            await feature(host, generator().generator).generate(root, "agent-1", input);
            await host.flushCommit();
            return { host, input };
        };

        const dangling = await prepare();
        dangling.host.receipts.delete(dangling.input.operationId!);
        await expect(
            feature(dangling.host, generator().generator).generate(root, "agent-1", dangling.input),
        ).rejects.toThrow("proof without its replay receipt");

        const missing = await prepare();
        missing.host.generationProofs.delete(missing.input.operationId!);
        await expect(
            feature(missing.host, generator().generator).generate(root, "agent-1", missing.input),
        ).rejects.toThrow("no immutable generation proof");

        const tamperedProof = await prepare();
        const proof = tamperedProof.host.generationProofs.get(tamperedProof.input.operationId!)!;
        if (proof.result.status !== "completed") throw new Error("test expected a completed proof");
        tamperedProof.host.generationProofs.set(tamperedProof.input.operationId!, {
            ...proof,
            result: {
                ...proof.result,
                asset: {
                    ...proof.result.asset,
                    locator: "asset://tampered",
                },
            },
        });
        await expect(
            feature(tamperedProof.host, generator().generator).generate(
                root,
                "agent-1",
                tamperedProof.input,
            ),
        ).rejects.toThrow("does not match the immutable generation proof");

        const tamperedReceipt = await prepare();
        const receipt = tamperedReceipt.host.receipts.get(tamperedReceipt.input.operationId!)!;
        if (receipt.result.status !== "completed") {
            throw new Error("test expected a completed receipt");
        }
        tamperedReceipt.host.receipts.set(tamperedReceipt.input.operationId!, {
            ...receipt,
            result: {
                ...receipt.result,
                asset: {
                    ...receipt.result.asset,
                    metadata: { provider: "tampered" },
                },
            },
        });
        await expect(
            feature(tamperedReceipt.host, generator().generator).generate(
                root,
                "agent-1",
                tamperedReceipt.input,
            ),
        ).rejects.toThrow("does not match the immutable generation proof");
    });

    it("does not certify a tampered status after its proof and receipt are deleted", async () => {
        const host = new HostImageStore();
        const input: ImageGenerationInput = {
            operationId: "operation-status-orphan",
            prompt: "An orphaned status",
        };
        await feature(host, generator().generator).generate(root, "agent-1", input);
        await host.flushCommit();

        const current = host.operations.get(input.operationId!)!;
        if (current.status !== "completed") throw new Error("test expected a completed status");
        host.operations.set(input.operationId!, {
            ...current,
            asset: { ...current.asset, locator: "asset://tampered-orphan" },
        });
        host.receipts.delete(input.operationId!);
        host.generationProofs.delete(input.operationId!);

        const writeReceipt = vi.spyOn(host.contract, "writeReceipt");
        const writeGenerationProof = vi.spyOn(host.contract, "writeGenerationProof");
        await expect(
            feature(host, generator().generator).generate(root, "agent-1", input),
        ).rejects.toThrow("status exists without an immutable proof and replay receipt");
        expect(writeReceipt).not.toHaveBeenCalled();
        expect(writeGenerationProof).not.toHaveBeenCalled();
        const orphan = host.operations.get(input.operationId!);
        expect(orphan?.status).toBe("completed");
        if (orphan?.status === "completed") {
            expect(orphan.asset.locator).toBe("asset://tampered-orphan");
        }
    });

    it("does not certify a status introduced by a racing create without its proof pair", async () => {
        const host = new HostImageStore();
        const originalStage = host.contract.stage;
        host.contract.stage = async (ctx, stageInput) => {
            const stage = await originalStage(ctx, stageInput);
            host.operations.set(stageInput.operationId, {
                operationId: stageInput.operationId,
                agentId: stageInput.agentId,
                fingerprint: stageInput.fingerprint,
                prompt: stageInput.prompt,
                ...(stageInput.options === undefined ? {} : { options: stageInput.options }),
                status: "pending",
                createdAt: 100,
                updatedAt: 100,
            });
            return stage;
        };

        const input: ImageGenerationInput = {
            operationId: "operation-racing-status",
            prompt: "A racing status",
        };
        await expect(
            feature(host, generator().generator).generate(root, "agent-1", input),
        ).rejects.toThrow("status exists without an immutable proof and replay receipt");
        expect(host.receipts.has(input.operationId!)).toBe(false);
        expect(host.generationProofs.has(input.operationId!)).toBe(false);
        expect(host.staged.size).toBe(0);
    });

    it("hashes the bounded canonical request into a lowercase fixed digest", async () => {
        const host = new HostImageStore();
        const generated = generator();
        const images = feature(host, generated.generator);
        const prompt = "\\".repeat(8_000);
        const style = "\\".repeat(512);
        await expect(
            images.generate(root, "agent-1", {
                operationId: "operation-maximum-fingerprint",
                prompt,
                options: { style },
            }),
        ).resolves.toMatchObject({ status: "completed" });

        const request = generated.generate.mock.calls[0]?.[1] as ImageGeneratorRequest | undefined;
        expect(request).toBeDefined();
        expect(Value.Check(imageFingerprintSchema, request?.fingerprint)).toBe(true);
        expect(request?.fingerprint).toBe(
            createHash("sha256")
                .update(
                    JSON.stringify({
                        agentId: "agent-1",
                        options: { style },
                        prompt,
                    }),
                    "utf8",
                )
                .digest("hex"),
        );
    });

    it("rejects an exact operation conflict after hashing the canonical request", async () => {
        const host = new HostImageStore();
        const generated = generator();
        const images = feature(host, generated.generator);
        const operationId = "operation-exact-conflict";
        await images.generate(root, "agent-1", { operationId, prompt: "First request" });
        await host.flushCommit();

        await expect(
            images.generate(root, "agent-1", { operationId, prompt: "Different request" }),
        ).rejects.toThrow("different input");
        expect(generated.generate).toHaveBeenCalledOnce();
    });

    it("keeps maximum legal identities actionable at the minimum model budget", () => {
        const host = new HostImageStore();
        const images = feature(host, generator().generator);
        const operationId = "o".repeat(MAX_IMAGE_ID_CHARACTERS);
        const assetId = "a".repeat(MAX_IMAGE_ID_CHARACTERS);
        const locator = "l".repeat(MAX_IMAGE_LOCATOR_CHARACTERS);
        const mediaType = `image/${"m".repeat(26)}`;
        const status: ImageGenerationStatus = {
            agentId: "agent-1",
            operationId,
            fingerprint: "0".repeat(64),
            prompt: "A prompt",
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
            asset: {
                id: assetId,
                agentId: "agent-1",
                operationId,
                mediaType,
                byteLength: 1,
                locator,
            },
        };
        expect(Value.Check(imageGenerationStatusSchema, status)).toBe(true);
        const output = images.formatForModel(status, 256);
        expect(output.length).toBeLessThanOrEqual(256);
        expect(output).toContain(operationId);
        expect(output).toContain(assetId);
        expect(output).toContain(mediaType);
        expect(output).toContain(locator);
    });

    it("rolls back a returned stage whose identity or metadata does not match", async () => {
        const host = new HostImageStore();
        const originalStage = host.contract.stage;
        host.contract.stage = async (ctx, input) => {
            const staged = await originalStage(ctx, input);
            return { ...staged, operationId: "different-operation" };
        };

        await expect(
            feature(host, generator().generator).generate(root, "agent-1", {
                prompt: "Mismatched stage",
            }),
        ).rejects.toThrow("different request");
        expect(host.staged.size).toBe(0);
    });

    it("rejects staged and create callback mutation through detached snapshots", async () => {
        const inputMutationHost = new HostImageStore();
        const originalStage = inputMutationHost.contract.stage;
        inputMutationHost.contract.stage = async (ctx, input) => {
            input.bytes[0] = 99;
            return await originalStage(ctx, input);
        };
        await expect(
            feature(inputMutationHost, generator().generator).generate(root, "agent-1", {
                prompt: "Mutated bytes",
            }),
        ).rejects.toThrow("mutated the staged image input");
        expect(inputMutationHost.staged.size).toBe(0);

        const createMutationHost = new HostImageStore();
        const originalCreate = createMutationHost.contract.create;
        createMutationHost.contract.create = async (ctx, input) => {
            if (input.stage.metadata !== undefined) {
                input.stage.metadata.provider = "mutated";
            }
            return await originalCreate(ctx, input);
        };
        await expect(
            feature(createMutationHost, generator().generator).generate(root, "agent-1", {
                prompt: "Mutated metadata",
            }),
        ).rejects.toThrow("mutated the image create input");
        expect(createMutationHost.operations.size).toBe(0);
        expect(createMutationHost.staged.size).toBe(0);
    });

    it("compares receipt readback to a detached expected snapshot", async () => {
        const host = new HostImageStore();
        const originalWriteReceipt = host.contract.writeReceipt;
        host.contract.writeReceipt = async (ctx, receipt) => {
            receipt.prompt = "tampered";
            return await originalWriteReceipt(ctx, receipt);
        };

        await expect(
            feature(host, generator().generator).generate(root, "agent-1", {
                prompt: "Receipt tamper",
            }),
        ).rejects.toThrow("durably persist");
        expect(host.receipts.size).toBe(0);
        expect(host.staged.size).toBe(0);
    });

    it("derives remove from authoritative before and after state", async () => {
        const noOpHost = new HostImageStore();
        const noOpImages = feature(noOpHost, generator().generator);
        await noOpImages.generate(root, "agent-1", { prompt: "Keep me" });
        await noOpHost.flushCommit();
        noOpHost.contract.remove = async () => false;
        await expect(noOpImages.remove(root, "agent-1", "asset-operation-1")).resolves.toBe(false);
        expect(noOpHost.assets.has("asset-operation-1")).toBe(true);

        const mutatedNoOpHost = new HostImageStore();
        const mutatedNoOpImages = feature(mutatedNoOpHost, generator().generator);
        await mutatedNoOpImages.generate(root, "agent-1", { prompt: "Do not rewrite me" });
        await mutatedNoOpHost.flushCommit();
        const originalAsset = structuredClone(mutatedNoOpHost.assets.get("asset-operation-1")!);
        mutatedNoOpHost.contract.remove = async (_ctx, query) => {
            const current = mutatedNoOpHost.assets.get(query.assetId)!;
            mutatedNoOpHost.assets.set(query.assetId, {
                ...current,
                locator: "asset://rewritten",
                metadata: { provider: "rewritten" },
            });
            return false;
        };
        await expect(
            mutatedNoOpImages.remove(root, "agent-1", "asset-operation-1"),
        ).rejects.toThrow("changed the asset");
        expect(mutatedNoOpHost.assets.get("asset-operation-1")).toEqual(originalAsset);

        const falseAfterDeleteHost = new HostImageStore();
        const falseAfterDeleteImages = feature(falseAfterDeleteHost, generator().generator);
        await falseAfterDeleteImages.generate(root, "agent-1", { prompt: "Delete mismatch" });
        await falseAfterDeleteHost.flushCommit();
        const originalRemove = falseAfterDeleteHost.contract.remove;
        falseAfterDeleteHost.contract.remove = async (ctx, query) => {
            await originalRemove(ctx, query);
            return false;
        };
        await expect(
            falseAfterDeleteImages.remove(root, "agent-1", "asset-operation-1"),
        ).rejects.toThrow("not authoritative");
        expect(falseAfterDeleteHost.assets.has("asset-operation-1")).toBe(true);
    });

    it("rejects malformed generator output, oversized output, options, and store metadata", async () => {
        const tooLarge = generator({ bytes: new Uint8Array(5), mediaType: "image/png" });
        await expect(
            feature(new HostImageStore(), tooLarge.generator, { maxOutputBytes: 4 }).generate(
                root,
                "agent-1",
                { prompt: "Too large" },
            ),
        ).rejects.toThrow("byte limit");

        const malformed = generator({
            bytes: new Uint8Array([1]),
            mediaType: "not-an-image",
        } as never);
        await expect(
            feature(new HostImageStore(), malformed.generator).generate(root, "agent-1", {
                prompt: "Bad metadata",
            }),
        ).rejects.toThrow("invalid image data");

        await expect(
            feature(new HostImageStore(), generator().generator).generate(root, "agent-1", {
                prompt: "Valid",
                options: { style: "x".repeat(600) },
            }),
        ).rejects.toThrow("input is invalid");
        await expect(
            feature(new HostImageStore(), generator().generator).generate(root, "agent-1", {
                prompt: "x".repeat(8_001),
            }),
        ).rejects.toThrow("input is invalid");

        expect(Value.Check(imageAssetSchema, { id: "only-id" })).toBe(false);
        expect(Value.Check(imageGenerationStatusSchema, { status: "completed" })).toBe(false);
        expect(Value.Check(imageGenerationReceiptSchema, {})).toBe(false);
    });

    it("rolls back staged data and suppresses post-commit events on transactional failure", async () => {
        const host = new HostImageStore();
        const transactional: ImageGenerationEvent[] = [];
        const postCommit: ImageGenerationEvent[] = [];
        const images = feature(host, generator().generator, {
            listener: {
                onEventTransactional: async (_ctx, event) => {
                    transactional.push(event);
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type === "image_generation_changed") {
                        expect(Object.isFrozen(event.operation)).toBe(true);
                    }
                },
                onEvent: async (_ctx, event) => {
                    postCommit.push(event);
                },
            },
        });
        const result = await images.generate(root, "agent-1", { prompt: "A comet" });
        expect(transactional).toHaveLength(1);
        expect(postCommit).toHaveLength(0);
        await host.flushCommit();
        expect(postCommit[0]).toBe(transactional[0]);
        expect(host.staged.size).toBe(0);
        expect(result.status).toBe("completed");

        const rollbackHost = new HostImageStore();
        const rollback = feature(rollbackHost, generator().generator, {
            listener: {
                onEventTransactional: async () => {
                    throw new Error("listener failed");
                },
            },
        });
        await expect(rollback.generate(root, "agent-1", { prompt: "Rollback" })).rejects.toThrow(
            "listener failed",
        );
        expect(rollbackHost.operations.size).toBe(0);
        expect(rollbackHost.receipts.size).toBe(0);
        expect(rollbackHost.staged.size).toBe(0);
    });

    it("contains post-commit listener errors and keeps the committed receipt", async () => {
        const host = new HostImageStore();
        const report = vi.fn().mockResolvedValue(undefined);
        const images = feature(host, generator().generator, {
            listener: {
                onEvent: async () => {
                    throw new Error("observer failed");
                },
            },
            onPostCommitError: report,
        });

        await images.generate(root, "agent-1", { prompt: "A lake" });
        await expect(host.flushCommit()).resolves.toBeUndefined();
        expect(report).toHaveBeenCalledOnce();
        expect(host.operations.size).toBe(1);
    });

    it("validates constructor options as a closed TypeBox contract", () => {
        const host = new HostImageStore();
        const generated = generator();
        const options = { generator: generated.generator, store: host.contract };
        expect(Value.Check(imageGenerationFeatureOptionsSchema, options)).toBe(true);
        expect(
            Value.Check(imageGenerationFeatureOptionsSchema, {
                ...options,
                unexpected: true,
            }),
        ).toBe(false);
    });
});
