import { describe, expect, it } from "vitest";

import {
    createCloudDeviceMetadata,
    decryptCloudDeviceMetadata,
    encryptCloudDeviceMetadata,
} from "../../sources/cloud/CloudDeviceMetadata.js";
import { createCloudKeyTree } from "../../sources/cloud/CloudKeyTree.js";

describe("Cloud device metadata", () => {
    it("encrypts metadata for one exact account and device", () => {
        const tree = createCloudKeyTree(new Uint8Array(32).fill(1));
        const accountKey = new Uint8Array(32).fill(2);
        const deviceKey = new Uint8Array(32).fill(3);
        const metadata = createCloudDeviceMetadata("instance-1", "0.4.23");
        try {
            const encrypted = encryptCloudDeviceMetadata(tree, accountKey, deviceKey, metadata);
            expect(encrypted).not.toEqual(new TextEncoder().encode(JSON.stringify(metadata)));
            expect(decryptCloudDeviceMetadata(tree, accountKey, deviceKey, encrypted)).toEqual(
                metadata,
            );
            expect(
                decryptCloudDeviceMetadata(tree, accountKey, new Uint8Array(32).fill(4), encrypted),
            ).toBeNull();
            expect(
                decryptCloudDeviceMetadata(tree, new Uint8Array(32).fill(5), deviceKey, encrypted),
            ).toBeNull();
        } finally {
            tree.destroy();
        }
    });

    it("rejects tampering, unknown versions, and invalid plaintext", () => {
        const tree = createCloudKeyTree(new Uint8Array(32).fill(6));
        const accountKey = new Uint8Array(32).fill(7);
        const deviceKey = new Uint8Array(32).fill(8);
        try {
            const encrypted = encryptCloudDeviceMetadata(
                tree,
                accountKey,
                deviceKey,
                createCloudDeviceMetadata("instance-2", "development"),
            );
            const tampered = encrypted.slice();
            tampered[tampered.length - 1]! ^= 1;
            expect(decryptCloudDeviceMetadata(tree, accountKey, deviceKey, tampered)).toBeNull();
            const future = encrypted.slice();
            future[0] = 2;
            expect(decryptCloudDeviceMetadata(tree, accountKey, deviceKey, future)).toBeNull();
            expect(
                decryptCloudDeviceMetadata(tree, accountKey, deviceKey, new Uint8Array()),
            ).toBeNull();
        } finally {
            tree.destroy();
        }
    });
});
