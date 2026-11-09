/** A click `/actions` refuses before anything is stored, with the status the route answers. */
export class ChatUiActionError extends Error {
    readonly status: 400 | 403 | 404 | 429;
    readonly code: "invalid_request" | "forbidden" | "not_found" | "rate_limited";

    constructor(
        status: ChatUiActionError["status"],
        code: ChatUiActionError["code"],
        message: string,
    ) {
        super(message);
        this.name = "ChatUiActionError";
        this.status = status;
        this.code = code;
    }
}
