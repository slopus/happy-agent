/*
 * Vendored from rocicorp/fractional-indexing at
 * f1193a783b08109f2813bea354813e4cc8724f5e.
 *
 * License: CC0-1.0 (no rights reserved).
 * Source: https://github.com/rocicorp/fractional-indexing
 *
 * Converted from JavaScript to TypeScript for Happy Terminal.
 */

export const BASE_62_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const BASE_52_DIGITS = BASE_62_DIGITS.slice(10);

const digitIndexCache = new Map<string, Uint8Array>();

function getDigitIndex(digits: string): Uint8Array {
    let index = digitIndexCache.get(digits);
    if (index === undefined) {
        index = new Uint8Array(256);
        for (let position = 0; position < digits.length; position += 1) {
            index[digits.charCodeAt(position)] = position;
        }
        digitIndexCache.set(digits, index);
    }
    return index;
}

function midpoint(
    a: string,
    b: string | null | undefined,
    digits: string,
    lookup: Uint8Array,
): string {
    const zero = digits[0]!;
    if (b != null && a >= b) {
        throw new Error(`${a} >= ${b}`);
    }
    if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
        throw new Error("trailing zero");
    }
    if (b) {
        let commonPrefixLength = 0;
        while ((a[commonPrefixLength] || zero) === b[commonPrefixLength]) {
            commonPrefixLength += 1;
        }
        if (commonPrefixLength > 0) {
            return (
                b.slice(0, commonPrefixLength) +
                midpoint(a.slice(commonPrefixLength), b.slice(commonPrefixLength), digits, lookup)
            );
        }
    }
    const digitA = a ? lookup[a.charCodeAt(0)]! : 0;
    const digitB = b != null ? lookup[b.charCodeAt(0)]! : digits.length;
    if (digitB - digitA > 1) {
        return digits[Math.round(0.5 * (digitA + digitB))]!;
    }
    if (b && b.length > 1) {
        return b.slice(0, 1);
    }
    return digits[digitA]! + midpoint(a.slice(1), null, digits, lookup);
}

function validateInteger(int: string, intDigits: string, intLookup: Uint8Array): void {
    if (int.length !== getIntegerLength(int[0]!, intDigits, intLookup)) {
        throw new Error(`invalid integer part of order key: ${int}`);
    }
}

function getIntegerLength(head: string, intDigits: string, intLookup: Uint8Array): number {
    const index = intLookup[head.charCodeAt(0)]!;
    if (intDigits[index] === head) {
        const half = intDigits.length / 2;
        return index < half ? half - index + 1 : index - half + 2;
    }
    throw new Error(`invalid order key head: ${head}`);
}

function getIntegerPart(key: string, intDigits: string, intLookup: Uint8Array): string {
    const integerPartLength = getIntegerLength(key[0]!, intDigits, intLookup);
    if (integerPartLength > key.length) {
        throw new Error(`invalid order key: ${key}`);
    }
    return key.slice(0, integerPartLength);
}

function validateOrderKey(
    key: string,
    digits: string,
    intDigits: string,
    intLookup: Uint8Array,
): void {
    if (isSmallestInteger(key, digits, intDigits)) {
        throw new Error(`invalid order key: ${key}`);
    }
    const integer = getIntegerPart(key, intDigits, intLookup);
    const fractional = key.slice(integer.length);
    if (fractional.slice(-1) === digits[0]) {
        throw new Error(`invalid order key: ${key}`);
    }
}

function incrementInteger(
    value: string,
    digits: string,
    lookup: Uint8Array,
    intDigits: string,
    intLookup: Uint8Array,
): string | null {
    validateInteger(value, intDigits, intLookup);
    const head = value[0]!;
    const zero = digits[0]!;
    let trailing = "";
    for (let index = value.length - 1; index >= 1; index -= 1) {
        const digit = lookup[value.charCodeAt(index)]! + 1;
        if (digit === digits.length) {
            trailing = zero + trailing;
        } else {
            return head + value.slice(1, index) + digits[digit]! + trailing;
        }
    }
    const headIndex = intLookup[head.charCodeAt(0)]!;
    if (headIndex === intDigits.length - 1) {
        return null;
    }
    const nextHead = intDigits[headIndex + 1]!;
    const lengthDelta =
        getIntegerLength(nextHead, intDigits, intLookup) -
        getIntegerLength(head, intDigits, intLookup);
    return (
        nextHead +
        (lengthDelta > 0 ? trailing + zero : lengthDelta < 0 ? trailing.slice(1) : trailing)
    );
}

function decrementInteger(
    value: string,
    digits: string,
    lookup: Uint8Array,
    intDigits: string,
    intLookup: Uint8Array,
): string | null {
    validateInteger(value, intDigits, intLookup);
    const head = value[0]!;
    const last = digits[digits.length - 1]!;
    let trailing = "";
    for (let index = value.length - 1; index >= 1; index -= 1) {
        const digit = lookup[value.charCodeAt(index)]! - 1;
        if (digit === -1) {
            trailing = last + trailing;
        } else {
            return head + value.slice(1, index) + digits[digit]! + trailing;
        }
    }
    const headIndex = intLookup[head.charCodeAt(0)]!;
    if (headIndex === 0) {
        return null;
    }
    const previousHead = intDigits[headIndex - 1]!;
    const lengthDelta =
        getIntegerLength(previousHead, intDigits, intLookup) -
        getIntegerLength(head, intDigits, intLookup);
    return (
        previousHead +
        (lengthDelta > 0 ? trailing + last : lengthDelta < 0 ? trailing.slice(1) : trailing)
    );
}

const repeatedKeysCache = new Map<string, Map<number, string>>();

function isSmallestInteger(key: string, digits: string, intDigits: string): boolean {
    let byDigit = repeatedKeysCache.get(intDigits);
    if (byDigit === undefined) {
        byDigit = new Map();
        repeatedKeysCache.set(intDigits, byDigit);
    }
    const zeroCode = digits.charCodeAt(0);
    let cached = byDigit.get(zeroCode);
    if (cached === undefined) {
        cached = intDigits[0]! + digits[0]!.repeat(intDigits.length / 2);
        byDigit.set(zeroCode, cached);
    }
    return key === cached;
}

function isStrictlyAscending(value: string): boolean {
    for (let index = 1; index < value.length; index += 1) {
        if (value.charCodeAt(index - 1) >= value.charCodeAt(index)) {
            return false;
        }
    }
    return true;
}

function isSingleByte(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) > 255) {
            return false;
        }
    }
    return true;
}

const validatedDigits = new Set<string>();

function validateDigits(digits: string): void {
    if (validatedDigits.has(digits)) {
        return;
    }
    if (digits.length < 2 || !isStrictlyAscending(digits)) {
        throw new Error(
            `digits must be at least 2 characters in strictly ascending character code order: ${digits}`,
        );
    }
    if (!isSingleByte(digits)) {
        throw new Error(`digits must be single-byte (char code 0-255): ${digits}`);
    }
    validatedDigits.add(digits);
}

const validatedIntDigits = new Set<string>();

function validateIntDigits(intDigits: string): void {
    if (validatedIntDigits.has(intDigits)) {
        return;
    }
    if (intDigits.length < 2 || intDigits.length % 2 !== 0 || !isStrictlyAscending(intDigits)) {
        throw new Error(
            `intDigits must be an even number of at least 2 characters in strictly ascending character code order: ${intDigits}`,
        );
    }
    if (!isSingleByte(intDigits)) {
        throw new Error(`intDigits must be single-byte (char code 0-255): ${intDigits}`);
    }
    validatedIntDigits.add(intDigits);
}

/**
 * Generates a key that sorts between `a` and `b`. A null bound represents
 * either end of the ordered range. Non-null bounds may be passed in either
 * order.
 */
export function generateKeyBetween(
    a: string | null | undefined,
    b: string | null | undefined,
    digits: string | undefined = undefined,
    intDigits: string | undefined = undefined,
): string {
    let resolvedIntDigits = intDigits;
    if (resolvedIntDigits !== undefined) {
        validateIntDigits(resolvedIntDigits);
    } else {
        resolvedIntDigits = digits ?? BASE_52_DIGITS;
    }
    let resolvedDigits = digits;
    if (resolvedDigits !== undefined) {
        validateDigits(resolvedDigits);
    } else {
        resolvedDigits = BASE_62_DIGITS;
    }

    const lookup = getDigitIndex(resolvedDigits);
    const intLookup = getDigitIndex(resolvedIntDigits);
    if (a != null) {
        validateOrderKey(a, resolvedDigits, resolvedIntDigits, intLookup);
    }
    if (b != null) {
        validateOrderKey(b, resolvedDigits, resolvedIntDigits, intLookup);
    }
    if (a != null && b != null && a > b) {
        [a, b] = [b, a];
    }

    if (a == null) {
        if (b == null) {
            const head = resolvedIntDigits[resolvedIntDigits.length / 2]!;
            return head + resolvedDigits[0]!;
        }

        const integerB = getIntegerPart(b, resolvedIntDigits, intLookup);
        const fractionalB = b.slice(integerB.length);
        if (isSmallestInteger(integerB, resolvedDigits, resolvedIntDigits)) {
            return integerB + midpoint("", fractionalB, resolvedDigits, lookup);
        }
        if (integerB < b) {
            return integerB;
        }
        const result = decrementInteger(
            integerB,
            resolvedDigits,
            lookup,
            resolvedIntDigits,
            intLookup,
        );
        if (result == null) {
            throw new Error("cannot decrement any more");
        }
        return result;
    }

    if (b == null) {
        const integerA = getIntegerPart(a, resolvedIntDigits, intLookup);
        const fractionalA = a.slice(integerA.length);
        const integer = incrementInteger(
            integerA,
            resolvedDigits,
            lookup,
            resolvedIntDigits,
            intLookup,
        );
        return integer == null
            ? integerA + midpoint(fractionalA, null, resolvedDigits, lookup)
            : integer;
    }

    const integerA = getIntegerPart(a, resolvedIntDigits, intLookup);
    const fractionalA = a.slice(integerA.length);
    const integerB = getIntegerPart(b, resolvedIntDigits, intLookup);
    const fractionalB = b.slice(integerB.length);
    if (integerA === integerB) {
        return integerA + midpoint(fractionalA, fractionalB, resolvedDigits, lookup);
    }
    const integer = incrementInteger(
        integerA,
        resolvedDigits,
        lookup,
        resolvedIntDigits,
        intLookup,
    );
    if (integer == null) {
        throw new Error("cannot increment any more");
    }
    if (integer < b) {
        return integer;
    }
    return integerA + midpoint(fractionalA, null, resolvedDigits, lookup);
}

/**
 * Generates `n` distinct, sorted keys between the two bounds.
 */
export function generateNKeysBetween(
    a: string | null | undefined,
    b: string | null | undefined,
    n: number,
    digits: string | undefined = undefined,
    intDigits: string | undefined = undefined,
): string[] {
    let resolvedIntDigits = intDigits;
    if (resolvedIntDigits !== undefined) {
        validateIntDigits(resolvedIntDigits);
    } else {
        resolvedIntDigits = digits ?? BASE_52_DIGITS;
    }
    let resolvedDigits = digits;
    if (resolvedDigits !== undefined) {
        validateDigits(resolvedDigits);
    } else {
        resolvedDigits = BASE_62_DIGITS;
    }

    if (n === 0) {
        return [];
    }
    if (n === 1) {
        return [generateKeyBetween(a, b, resolvedDigits, resolvedIntDigits)];
    }
    if (b == null) {
        let key = generateKeyBetween(a, b, resolvedDigits, resolvedIntDigits);
        const result = [key];
        for (let index = 0; index < n - 1; index += 1) {
            key = generateKeyBetween(key, b, resolvedDigits, resolvedIntDigits);
            result.push(key);
        }
        return result;
    }
    if (a == null) {
        let key = generateKeyBetween(a, b, resolvedDigits, resolvedIntDigits);
        const result = [key];
        for (let index = 0; index < n - 1; index += 1) {
            key = generateKeyBetween(a, key, resolvedDigits, resolvedIntDigits);
            result.push(key);
        }
        result.reverse();
        return result;
    }
    const middle = Math.floor(n / 2);
    const key = generateKeyBetween(a, b, resolvedDigits, resolvedIntDigits);
    return [
        ...generateNKeysBetween(a, key, middle, resolvedDigits, resolvedIntDigits),
        key,
        ...generateNKeysBetween(key, b, n - middle - 1, resolvedDigits, resolvedIntDigits),
    ];
}
