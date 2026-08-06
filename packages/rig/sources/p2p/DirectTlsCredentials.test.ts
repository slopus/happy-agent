import { X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { createDirectTlsCredentials, verifyDirectTlsCertificate } from "./DirectTlsCredentials.js";

describe("direct P2P TLS credentials", () => {
    it("self-signs the TLS certificate with the stable Rig identity key", async () => {
        const identity = createP2pInstanceIdentity(
            "ck1234567890abcdefghijkl",
            Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        );
        const credentials = await createDirectTlsCredentials(identity, Date.UTC(2026, 0, 1));
        const certificate = new X509Certificate(credentials.certificate);

        expect(verifyDirectTlsCertificate(certificate, Date.UTC(2026, 0, 1))).toBe(
            identity.publicKey,
        );
        expect(certificate.publicKey.asymmetricKeyType).toBe("ed25519");
        expect(credentials.privateKey).toContain("BEGIN PRIVATE KEY");
    });

    it("emits a canonical DER serial when the hash begins with zero", async () => {
        const identity = createP2pInstanceIdentity(
            "ck1234567890abcdefghijkl",
            Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        );
        const now = Date.UTC(2026, 0, 1) + 147;
        const credentials = await createDirectTlsCredentials(identity, now);

        expect(verifyDirectTlsCertificate(new X509Certificate(credentials.certificate), now)).toBe(
            identity.publicKey,
        );
    });

    it("uses GeneralizedTime when the long-lived certificate crosses 2050", async () => {
        const identity = createP2pInstanceIdentity();
        const now = Date.UTC(2045, 0, 1);
        const credentials = await createDirectTlsCredentials(identity, now);

        expect(verifyDirectTlsCertificate(new X509Certificate(credentials.certificate), now)).toBe(
            identity.publicKey,
        );
    });
});
