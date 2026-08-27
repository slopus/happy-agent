import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();
const CHILD_SEPARATOR = 0;
const CLOUD_KEY_TREE_USAGE = "Happy Agent Cloud";
const KEY_BYTES = 32;

interface KeyTreeState {
    readonly chainCode: Uint8Array;
    readonly key: Uint8Array;
}

export interface CloudDerivedKeyPair {
    readonly public: Uint8Array;
    readonly secret: Uint8Array;
}

/**
 * An in-memory, domain-separated key tree derived from one secret root.
 *
 * The construction intentionally matches privacy-kit's HMAC-SHA-512 tree:
 * roots use HMAC(`${usage} Master Seed`, seed), children use
 * HMAC(chainCode, 0x00 || UTF8(pathElement)), and the two output halves are
 * the child key and next chain code.
 */
export class CloudKeyTree {
    #chainCode: Uint8Array;
    #destroyed = false;

    private constructor(chainCode: Uint8Array) {
        if (chainCode.byteLength !== KEY_BYTES) throw new Error("The key-tree root is invalid.");
        this.#chainCode = chainCode.slice();
    }

    static fromSeed(seed: string | Uint8Array, usage: string): CloudKeyTree {
        const bytes = typeof seed === "string" ? encoder.encode(seed) : seed;
        const state = deriveRoot(bytes, usage);
        try {
            return new CloudKeyTree(state.chainCode);
        } finally {
            state.key.fill(0);
            state.chainCode.fill(0);
        }
    }

    subtree(path: readonly string[]): CloudKeyTree {
        const chainCode = this.#deriveSubtree(path);
        try {
            return new CloudKeyTree(chainCode);
        } finally {
            chainCode.fill(0);
        }
    }

    deriveSymmetricKey(path: readonly string[]): Uint8Array {
        return this.#deriveKey("aes256", path);
    }

    deriveCurve25519Key(path: readonly string[]): CloudDerivedKeyPair {
        const secret = this.#deriveKey("nacl", path);
        return { public: x25519.getPublicKey(secret), secret };
    }

    deriveEd25519Key(path: readonly string[]): CloudDerivedKeyPair {
        const secret = this.#deriveKey("ed25519", path);
        return { public: ed25519.getPublicKey(secret), secret };
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.#destroyed = true;
        this.#chainCode.fill(0);
    }

    #deriveKey(algorithm: string, path: readonly string[]): Uint8Array {
        return this.#walk([...validatePath(path), `#${algorithm}`], false);
    }

    #deriveSubtree(path: readonly string[]): Uint8Array {
        return this.#walk(validatePath(path), true);
    }

    #walk(path: readonly string[], returnChainCode: boolean): Uint8Array {
        if (this.#destroyed) throw new Error("The key tree has been destroyed.");
        let state = this.#chainCode;
        let ownsState = false;
        try {
            for (let index = 0; index < path.length; index += 1) {
                const child = deriveChild(state, path[index]!);
                if (ownsState) state.fill(0);
                const last = index === path.length - 1;
                if (last) {
                    const result = returnChainCode ? child.chainCode : child.key;
                    const discarded = returnChainCode ? child.key : child.chainCode;
                    discarded.fill(0);
                    return result;
                }
                child.key.fill(0);
                state = child.chainCode;
                ownsState = true;
            }
            throw new Error("A key-tree path must not be empty.");
        } finally {
            if (ownsState) state.fill(0);
        }
    }
}

/** Builds the account key tree from the persisted 32-byte Cloud master secret. */
export function createCloudKeyTree(masterSecret: Uint8Array): CloudKeyTree {
    if (masterSecret.byteLength !== KEY_BYTES) {
        throw new Error("The Cloud master secret must contain exactly 32 bytes.");
    }
    return CloudKeyTree.fromSeed(masterSecret, CLOUD_KEY_TREE_USAGE);
}

function deriveRoot(seed: Uint8Array, usage: string): KeyTreeState {
    return split(hmac(sha512, encoder.encode(`${usage} Master Seed`), seed));
}

function deriveChild(chainCode: Uint8Array, index: string): KeyTreeState {
    const encoded = encoder.encode(index);
    const data = new Uint8Array(encoded.byteLength + 1);
    data[0] = CHILD_SEPARATOR;
    data.set(encoded, 1);
    try {
        return split(hmac(sha512, chainCode, data));
    } finally {
        data.fill(0);
    }
}

function split(derived: Uint8Array): KeyTreeState {
    try {
        return {
            chainCode: derived.slice(KEY_BYTES),
            key: derived.slice(0, KEY_BYTES),
        };
    } finally {
        derived.fill(0);
    }
}

function validatePath(path: readonly string[]): readonly string[] {
    if (path.length === 0) throw new Error("A key-tree path must not be empty.");
    for (const element of path) {
        if (element.length === 0 || element.startsWith("#")) {
            throw new Error("A key-tree path element must be nonempty and must not start with #.");
        }
    }
    return path;
}
