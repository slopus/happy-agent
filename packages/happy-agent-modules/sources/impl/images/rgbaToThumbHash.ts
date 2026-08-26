/**
 * Encode non-premultiplied RGBA pixels using Evan Wallace's ThumbHash format.
 *
 * The modules package owns this shared local encoder, so features that store image placeholders
 * need no ThumbHash runtime dependency.
 */
export function rgbaToThumbHash(width: number, height: number, rgba: Uint8Array): Uint8Array {
    if (
        width < 1 ||
        height < 1 ||
        width > 100 ||
        height > 100 ||
        rgba.byteLength !== width * height * 4
    ) {
        throw new Error("The ThumbHash source image is invalid.");
    }

    let averageRed = 0;
    let averageGreen = 0;
    let averageBlue = 0;
    let averageAlpha = 0;
    for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 4) {
        const alpha = rgba[offset + 3]! / 255;
        averageRed += (alpha / 255) * rgba[offset]!;
        averageGreen += (alpha / 255) * rgba[offset + 1]!;
        averageBlue += (alpha / 255) * rgba[offset + 2]!;
        averageAlpha += alpha;
    }
    if (averageAlpha > 0) {
        averageRed /= averageAlpha;
        averageGreen /= averageAlpha;
        averageBlue /= averageAlpha;
    }

    const hasAlpha = averageAlpha < width * height;
    const luminanceLimit = hasAlpha ? 5 : 7;
    const luminanceX = Math.max(1, Math.round((luminanceLimit * width) / Math.max(width, height)));
    const luminanceY = Math.max(1, Math.round((luminanceLimit * height) / Math.max(width, height)));
    const luminance: number[] = [];
    const yellowBlue: number[] = [];
    const redGreen: number[] = [];
    const alphaChannel: number[] = [];
    for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 4) {
        const alpha = rgba[offset + 3]! / 255;
        const red = averageRed * (1 - alpha) + (alpha / 255) * rgba[offset]!;
        const green = averageGreen * (1 - alpha) + (alpha / 255) * rgba[offset + 1]!;
        const blue = averageBlue * (1 - alpha) + (alpha / 255) * rgba[offset + 2]!;
        luminance[pixel] = (red + green + blue) / 3;
        yellowBlue[pixel] = (red + green) / 2 - blue;
        redGreen[pixel] = red - green;
        alphaChannel[pixel] = alpha;
    }

    const encodeChannel = (
        channel: readonly number[],
        frequencyX: number,
        frequencyY: number,
    ): readonly [number, number[], number] => {
        let dc = 0;
        const ac: number[] = [];
        let scale = 0;
        const cosineX: number[] = [];
        for (let yFrequency = 0; yFrequency < frequencyY; yFrequency += 1) {
            for (
                let xFrequency = 0;
                xFrequency * frequencyY < frequencyX * (frequencyY - yFrequency);
                xFrequency += 1
            ) {
                let factor = 0;
                for (let x = 0; x < width; x += 1) {
                    cosineX[x] = Math.cos((Math.PI / width) * xFrequency * (x + 0.5));
                }
                for (let y = 0; y < height; y += 1) {
                    const cosineY = Math.cos((Math.PI / height) * yFrequency * (y + 0.5));
                    for (let x = 0; x < width; x += 1) {
                        factor += channel[x + y * width]! * cosineX[x]! * cosineY;
                    }
                }
                factor /= width * height;
                if (xFrequency !== 0 || yFrequency !== 0) {
                    ac.push(factor);
                    scale = Math.max(scale, Math.abs(factor));
                } else {
                    dc = factor;
                }
            }
        }
        if (scale > 0) {
            for (let index = 0; index < ac.length; index += 1) {
                ac[index] = 0.5 + (0.5 / scale) * ac[index]!;
            }
        }
        return [dc, ac, scale];
    };

    const [luminanceDc, luminanceAc, luminanceScale] = encodeChannel(
        luminance,
        Math.max(3, luminanceX),
        Math.max(3, luminanceY),
    );
    const [yellowBlueDc, yellowBlueAc, yellowBlueScale] = encodeChannel(yellowBlue, 3, 3);
    const [redGreenDc, redGreenAc, redGreenScale] = encodeChannel(redGreen, 3, 3);
    const [alphaDc, alphaAc, alphaScale] = hasAlpha
        ? encodeChannel(alphaChannel, 5, 5)
        : [0, [], 0];

    const landscape = width > height;
    const header24 =
        Math.round(63 * luminanceDc) |
        (Math.round(31.5 + 31.5 * yellowBlueDc) << 6) |
        (Math.round(31.5 + 31.5 * redGreenDc) << 12) |
        (Math.round(31 * luminanceScale) << 18) |
        (Number(hasAlpha) << 23);
    const header16 =
        (landscape ? luminanceY : luminanceX) |
        (Math.round(63 * yellowBlueScale) << 3) |
        (Math.round(63 * redGreenScale) << 9) |
        (Number(landscape) << 15);
    const hash: number[] = [
        header24 & 255,
        (header24 >> 8) & 255,
        header24 >> 16,
        header16 & 255,
        header16 >> 8,
    ];
    const acStart = hasAlpha ? 6 : 5;
    let acIndex = 0;
    if (hasAlpha) hash.push(Math.round(15 * alphaDc) | (Math.round(15 * alphaScale) << 4));
    for (const channel of hasAlpha
        ? [luminanceAc, yellowBlueAc, redGreenAc, alphaAc]
        : [luminanceAc, yellowBlueAc, redGreenAc]) {
        for (const factor of channel) {
            const index = acStart + (acIndex >> 1);
            hash[index] = (hash[index] ?? 0) | (Math.round(15 * factor) << ((acIndex++ & 1) << 2));
        }
    }
    return new Uint8Array(hash);
}
