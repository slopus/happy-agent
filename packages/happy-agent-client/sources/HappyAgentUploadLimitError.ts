/** The client or daemon exhausted an incomplete upload's byte-carrying request budget. */
export class HappyAgentUploadLimitError extends Error {
    constructor(options?: ErrorOptions) {
        super(
            "The upload reached its request limit. Cancel the incomplete upload and start again with larger chunks.",
            options,
        );
        this.name = "HappyAgentUploadLimitError";
    }
}
