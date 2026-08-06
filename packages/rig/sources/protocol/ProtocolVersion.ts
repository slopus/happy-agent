/**
 * Version of the HTTP/SSE contract spoken by this daemon.
 *
 * This is deliberately independent of the Rig package version: a release may
 * change without changing the wire contract, while an incompatible protocol
 * change must advance this number.
 */
export const RIG_PROTOCOL_VERSION = 10;
