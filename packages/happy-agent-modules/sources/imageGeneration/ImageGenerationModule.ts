import type {
    AgentBaseAcceptedMessage,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import {
    imageGenerationArgumentsSchema,
    selectedPaths,
    selectedRecentCount,
    type ImageGenerationArguments,
    type ImageGenerationResult,
} from "./ImageGeneration.js";
import { decodeAndValidatePng } from "../impl/images/decodeAndValidatePng.js";
import { writeGeneratedImageFile } from "../impl/images/writeGeneratedImageFile.js";
import { codexImageProviderIds, generateImageWithCodex } from "./impl/generateImageWithCodex.js";
import {
    assertAggregateImageSize,
    prepareReferencedImages,
} from "./impl/prepareReferencedImages.js";
import { RecentImages } from "./impl/RecentImages.js";
import { codexImageGenerationTool } from "./tools/codex_imagegen.js";

/** What one generation needs to know beyond the model's own arguments. */
export interface ImageGenerationRequest {
    /** The tool call this image belongs to; the provider takes it as the turn identity. */
    readonly turnId: string;
    /** The account this chat runs on, tried first whenever it can generate images. */
    readonly preferredProviderId?: string;
    readonly signal?: AbortSignal;
}

/**
 * Image generation, run by the module itself.
 *
 * One prompt becomes one PNG on the configured Codex accounts, saved into the shared
 * generated-files folder and handed back to the model so it can look at what it made. Nothing is
 * delegated to a host: the module owns the account order, the request, the validation, and the
 * file, and it takes the accounts and that folder from the module that owns them.
 */
export class ImageGenerationModule implements AgentModule {
    readonly name = "image-generation";

    readonly #config: ConfigModule;
    readonly #recentImages = new RecentImages();
    /** One image at a time per agent: each generation is billed, and each picks an account. */
    readonly #locks: MapAsyncLock<string> = mapAsyncLock<string>();
    #roundRobinOffset = 0;

    constructor(config: ConfigModule) {
        this.#config = config;
    }

    /** How many accounts this agent's request could be sent to, for an approval to disclose. */
    get accountCount(): number {
        return codexImageProviderIds(this.#config.providers, (id) =>
            this.#config.isProviderEnabled(id),
        ).length;
    }

    /** Generate one image, write it to the shared generated-files folder, and return it. */
    async generate(
        ctx: Context,
        agentId: string,
        args: ImageGenerationArguments,
        request: ImageGenerationRequest,
    ): Promise<ImageGenerationResult> {
        if (!Value.Check(imageGenerationArgumentsSchema, args)) {
            throw new Error("Image generation arguments are invalid.");
        }
        return await this.#locks.runInLock(
            ctx,
            agentId,
            async (lockCtx) => await this.#generate(lockCtx, agentId, args, request),
        );
    }

    async #generate(
        ctx: Context,
        agentId: string,
        args: ImageGenerationArguments,
        request: ImageGenerationRequest,
    ): Promise<ImageGenerationResult> {
        const paths = selectedPaths(args);
        const recent = selectedRecentCount(args);
        if (paths !== undefined && recent !== undefined) {
            throw new Error(
                "Provide only one of referenced_image_paths or num_last_images_to_include.",
            );
        }
        const images =
            paths === undefined
                ? recent === undefined
                    ? []
                    : this.#recentImages.take(agentId, recent)
                : await prepareReferencedImages(paths);
        assertAggregateImageSize(images);

        const generated = await generateImageWithCodex({
            providers: this.#config.providers,
            order: this.#accountOrder(request.preferredProviderId),
            prompt: args.prompt,
            images,
            turnId: request.turnId,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const bytes = await decodeAndValidatePng(generated.base64);
        const fileName = `${request.turnId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}.png`;
        const path = await writeGeneratedImageFile(
            this.#config.configuration.paths.generatedPath,
            fileName,
            bytes,
        );
        // The model may want to edit what it just made, and nothing else will remember it.
        this.#recentImages.record(agentId, generated.mediaType, generated.base64);
        return {
            bytes: bytes.byteLength,
            image_base64: generated.base64,
            media_type: generated.mediaType,
            path,
        };
    }

    /**
     * Which account to ask first.
     *
     * The account this chat already runs on leads, because it is the one known to be signed in and
     * paid for. The rest follow in a rotating order, so several images in a row do not all land on
     * the same second account.
     */
    #accountOrder(preferredProviderId: string | undefined): readonly string[] {
        const accounts = codexImageProviderIds(this.#config.providers, (id) =>
            this.#config.isProviderEnabled(id),
        );
        if (accounts.length === 0) return accounts;
        const offset = this.#roundRobinOffset++ % accounts.length;
        const rotated = [...accounts.slice(offset), ...accounts.slice(0, offset)];
        const preferred = rotated.find((candidate) => candidate === preferredProviderId);
        return preferred === undefined
            ? rotated
            : [preferred, ...rotated.filter((candidate) => candidate !== preferred)];
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * One image tool, the same for every model, because one Codex path backs all of them.
         * Without an enabled Codex account there is nothing behind the tool, so it is not
         * offered at all rather than failing every call.
         */
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] =>
            this.accountCount === 0
                ? []
                : [codexImageGenerationTool(this, scope.agent.id, scope.agent.provider)],

        /** An image a person attached is one an edit may target, so it is remembered here. */
        messageAccepted: (
            _ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): void => {
            const message = accepted.message;
            if (message.role !== "user") return;
            for (const block of message.content) {
                if (block.type !== "image") continue;
                this.#recentImages.record(scope.agent.id, block.mimeType, block.data);
            }
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
