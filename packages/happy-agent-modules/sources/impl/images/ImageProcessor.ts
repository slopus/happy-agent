export type SupportedImageFormat = "jpeg" | "png" | "webp";

export interface ImageMetadata {
    readonly format: string;
    readonly height: number;
    readonly width: number;
}

export interface ImageResize {
    readonly filter: "lanczos3" | "linear";
    readonly fit: "fill" | "inside";
    readonly height: number;
    readonly width: number;
    readonly withoutEnlargement?: boolean;
}

export interface ProcessedImage {
    readonly data: Buffer;
    readonly height: number;
    readonly width: number;
}

export interface ImageProcessor {
    encode(
        input: Uint8Array,
        options: {
            readonly autoOrient: boolean;
            readonly format: SupportedImageFormat;
            readonly lossless?: boolean;
            readonly maxPixels: number;
            readonly preserveMetadata?: boolean;
            readonly quality?: number;
            readonly resize?: ImageResize;
        },
    ): Promise<ProcessedImage>;
    metadata(
        input: Uint8Array,
        options: { readonly autoOrient: boolean; readonly maxPixels: number },
    ): Promise<ImageMetadata>;
    rgba(
        input: Uint8Array,
        options: {
            readonly autoOrient: boolean;
            readonly maxPixels: number;
            readonly resize: ImageResize;
        },
    ): Promise<ProcessedImage>;
    validate(
        input: Uint8Array,
        options: { readonly autoOrient: boolean; readonly maxPixels: number },
    ): Promise<void>;
}
