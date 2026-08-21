/**
 * Version of the HTTP/SSE contract spoken by this daemon.
 *
 * This is deliberately independent of the Happy Terminal package version: a release may
 * change without changing the wire contract, while an incompatible protocol
 * change must advance this number.
 */
export const HAPPY_TERMINAL_PROTOCOL_VERSION = 17;
