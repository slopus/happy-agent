/** An image that could not be decoded, measured, or normalized for a prompt. */
export class ImageProcessingError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ImageProcessingError";
    }
}
