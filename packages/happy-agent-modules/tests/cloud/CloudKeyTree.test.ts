import { describe, expect, it } from "vitest";

import { CloudKeyTree, createCloudKeyTree } from "../../sources/cloud/CloudKeyTree.js";

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex").toUpperCase();

describe("CloudKeyTree", () => {
    it("matches privacy-kit's published symmetric derivation vectors", () => {
        const tree = CloudKeyTree.fromSeed("some test seed", "test usage");
        try {
            expect(hex(tree.deriveSymmetricKey(["child1"]))).toBe(
                "F0F068E3D385210FF36440342EA073EDA97C7592B58A13A7C6CDF5448B789669",
            );
            expect(hex(tree.deriveSymmetricKey(["child1", "child2"]))).toBe(
                "B632B72A54C4E8C4735D27954BB1385395F6FEB003B8BFD6C3FAAE57C238F454",
            );
        } finally {
            tree.destroy();
        }
    });

    it("matches privacy-kit's symmetric and Curve25519 snapshots using Noble", () => {
        const tree = CloudKeyTree.fromSeed("test", "testcase");
        try {
            expect(hex(tree.deriveSymmetricKey(["test", "path"]))).toBe(
                "CCC809D2C060F756F773575479711F3F2784164F8E4759599E396DE57D436414",
            );
            const keyPair = tree.deriveCurve25519Key(["test", "path"]);
            expect(hex(keyPair.secret)).toBe(
                "E3CA73756C8123C98C3EEF5509A3AC4DD033D6135A4F99EDD500A5946FEEA3B0",
            );
            expect(hex(keyPair.public)).toBe(
                "7B37D9F396527FC5B1495FAABCDD62737CEB928A6B4712C2625114710FB8CD75",
            );
            keyPair.secret.fill(0);
            keyPair.public.fill(0);
        } finally {
            tree.destroy();
        }
    });

    it("derives stable, domain-separated account children and destroys retained state", () => {
        const master = Buffer.alloc(32, 7);
        const first = createCloudKeyTree(master);
        const second = createCloudKeyTree(master);
        try {
            const firstIdentity = first.deriveEd25519Key(["murmur", "identity"]);
            const secondIdentity = second.deriveEd25519Key(["murmur", "identity"]);
            const identitySecret = first.deriveSymmetricKey(["murmur", "identity"]);
            const storeSecret = first.deriveSymmetricKey(["murmur", "store"]);
            try {
                expect(firstIdentity).toEqual(secondIdentity);
                expect(identitySecret).not.toEqual(storeSecret);
            } finally {
                firstIdentity.secret.fill(0);
                firstIdentity.public.fill(0);
                secondIdentity.secret.fill(0);
                secondIdentity.public.fill(0);
                identitySecret.fill(0);
                storeSecret.fill(0);
            }
        } finally {
            first.destroy();
            second.destroy();
        }
        expect(() => first.deriveSymmetricKey(["murmur", "store"])).toThrow(
            "The key tree has been destroyed.",
        );
    });

    it("reserves algorithm path elements", () => {
        const tree = CloudKeyTree.fromSeed("test", "testcase");
        try {
            expect(() => tree.deriveSymmetricKey([])).toThrow("must not be empty");
            expect(() => tree.deriveSymmetricKey(["#nacl"])).toThrow("must not start with #");
        } finally {
            tree.destroy();
        }
    });
});
