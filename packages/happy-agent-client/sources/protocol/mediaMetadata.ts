import { type Static, Type } from "@sinclair/typebox";

/** Pixel size of the bytes served by a media's preview address. */
export const mediaPreviewSchema = Type.Object({
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
});
export type MediaPreview = Static<typeof mediaPreviewSchema>;
