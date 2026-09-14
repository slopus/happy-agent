export class ServiceEndpointUnavailableError extends Error {
    constructor(message = "The service endpoint is not reachable yet.") {
        super(message);
        this.name = "ServiceEndpointUnavailableError";
    }
}

export class ServiceTeardownError extends Error {
    constructor(
        message = "Service teardown could not be confirmed. Its workspace files must be retained.",
    ) {
        super(message);
        this.name = "ServiceTeardownError";
    }
}
