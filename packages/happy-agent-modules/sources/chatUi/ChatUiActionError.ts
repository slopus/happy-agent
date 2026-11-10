/** A click `/actions` refuses before anything is stored, with the status the route answers. */
export class ChatUiActionError extends Error {
    readonly status: 400 | 403 | 404 | 409 | 429;
    readonly code: "invalid_request" | "forbidden" | "not_found" | "conflict" | "rate_limited";

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
