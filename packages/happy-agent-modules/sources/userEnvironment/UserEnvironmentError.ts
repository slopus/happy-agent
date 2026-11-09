/**
 * A report the module refuses, with a message that is safe to show. `invalid_request` is the only
 * code: a field of the wrong shape, or a time zone or language the runtime does not recognize.
 */
export class UserEnvironmentError extends Error {
    readonly code = "invalid_request";
}
