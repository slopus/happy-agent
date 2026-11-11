/**
 * The published version of this package, for callers that must refuse an older library at runtime,
 * where a compiled binary has no `package.json` to read. A test keeps it equal to the package's own
 * version, so a release that bumps one without the other fails before it publishes.
 */
export const HAPPY_PROVIDERS_VERSION = "0.0.62";
