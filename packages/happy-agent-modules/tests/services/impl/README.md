# Service helper tests

The establishment-credential tests cover independent credentials, all four scope dimensions,
five-minute expiry, daemon replacement, tampering, malformed data, and non-reflecting errors.

The output-reader tests cover separate agent/API/principal identities, consuming reads, the
64-reader boundary, idle expiry/reset warnings, bounded retirement tracking, capture loss, and
UTF-8-safe response limits. They script capture only; native process capture is tested in Compute.
