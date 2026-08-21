export class RemoteAgentRunError extends Error {
    readonly debugDirectory: string | undefined;

    constructor(message: string, debugDirectory?: string) {
        super(message);
        this.name = "RemoteAgentRunError";
        this.debugDirectory = debugDirectory;
    }
}
