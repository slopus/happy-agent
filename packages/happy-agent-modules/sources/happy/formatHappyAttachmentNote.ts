/** One attachment saved where the agent works. */
export interface HappySavedAttachment {
    readonly isImage: boolean;
    /** Absolute on the machine the agent works on. */
    readonly path: string;
}

/**
 * What the agent reads after the person's words: where each attachment is, and that it is not
 * loaded. The agent decides whether to open it.
 *
 * The wording is shared with Happy CLI and the phones' direct chats, so every way a picture
 * reaches an agent reads the same, and clients can find these lines to show the pictures again.
 */
export function formatHappyAttachmentNote(
    files: readonly HappySavedAttachment[],
): string | undefined {
    if (files.length === 0) return undefined;
    const noun = files.every((file) => file.isImage) ? "image" : "file";
    const one = files.length === 1;
    const count = one ? `1 ${noun}` : `${String(files.length)} ${noun}s`;
    const pronoun = one ? "It was" : "They were";
    const object = one ? "it" : "them";
    return [
        `The user attached ${count}. ${pronoun} saved on this machine and not loaded into your context; open ${object} with your file-reading or image-viewing tool only if you need to see ${object}:`,
        ...files.map((file) => `- ${file.path}`),
    ].join("\n");
}
