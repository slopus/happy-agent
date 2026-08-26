export interface PromptImageResizeLimits {
    maxDimension: number;
    maxPatches: number;
}

export interface PromptImageDimensions {
    width: number;
    height: number;
}

const PATCH_SIZE = 32;

/**
 * The size an image is sent at.
 *
 * A model reads an image as a grid of fixed-size patches, so an image is bounded twice: by its
 * longest side, and by how many patches the whole picture becomes. Whichever bound binds first
 * decides the scale, and the result is floored to whole patches so nothing is paid for twice.
 */
export function promptImageOutputDimensions(
    inputWidth: number,
    inputHeight: number,
    limits: PromptImageResizeLimits,
): PromptImageDimensions {
    const width = Math.max(1, inputWidth);
    const height = Math.max(1, inputHeight);
    const initialPatchCount = Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE);
    if (
        width <= limits.maxDimension &&
        height <= limits.maxDimension &&
        initialPatchCount <= limits.maxPatches
    ) {
        return { width, height };
    }

    const dimensionScale = Math.min(limits.maxDimension / Math.max(width, height), 1);
    const dimensionWidth = Math.max(1, Math.round(width * dimensionScale));
    const dimensionHeight = Math.max(1, Math.round(height * dimensionScale));
    const dimensionPatchCount =
        Math.ceil(dimensionWidth / PATCH_SIZE) * Math.ceil(dimensionHeight / PATCH_SIZE);
    if (dimensionPatchCount <= limits.maxPatches) {
        return { width: dimensionWidth, height: dimensionHeight };
    }

    let patchScale = Math.sqrt(
        (PATCH_SIZE * PATCH_SIZE * limits.maxPatches) / dimensionWidth / dimensionHeight,
    );
    const scaledPatchesWide = (dimensionWidth * patchScale) / PATCH_SIZE;
    const scaledPatchesHigh = (dimensionHeight * patchScale) / PATCH_SIZE;
    patchScale *= Math.min(
        Math.floor(scaledPatchesWide) / scaledPatchesWide,
        Math.floor(scaledPatchesHigh) / scaledPatchesHigh,
    );

    return {
        width: Math.max(1, Math.floor(dimensionWidth * patchScale)),
        height: Math.max(1, Math.floor(dimensionHeight * patchScale)),
    };
}
