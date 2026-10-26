/** An exposure could not open because another program already listens on its fixed port. */
export class TailcatPortInUseError extends Error {
    override readonly name = "TailcatPortInUseError";
    readonly port: number;

    constructor(port: number, options?: ErrorOptions) {
        super(`Tailcat port ${String(port)} is already in use.`, options);
        this.port = port;
    }
}
