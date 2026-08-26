/**
 * The bounds every reference image is read and sent under.
 *
 * These belong to the image pipeline rather than to one vendor: whoever an image is being sent to,
 * a file too large to decode is refused before it is read, and a set of files that each fit on
 * their own is still refused when together they exceed what one request may carry.
 */

/** The largest source image, and the largest aggregate of them, a prompt may be built from. */
export const MAX_PROMPT_IMAGE_INPUT_BYTES = 32 * 1024 * 1024;

/** The encoded request stays within what the image endpoints accept. */
export const MAX_REFERENCE_IMAGES_ENCODED_BYTES = 48 * 1024 * 1024;
