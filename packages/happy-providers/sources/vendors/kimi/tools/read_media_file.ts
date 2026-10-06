import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_read_media_file_tool: SessionTool = {
    name: "ReadMediaFile",
    description:
        "Read media content from a file.\n\nThe path may be a `kimi-file://` attachment reference. Its bytes come from the current session's storage, independently of the workspace runtime, including after a fork. Any reported local attachment path belongs to the server; external converters must be able to access that filesystem.\n\n**Tips:**\n- Make sure you follow the description of each tool parameter.\n- A `<system>` tag accompanies the media content; it summarizes the mime type, byte size and, for images, the original pixel dimensions, and states how the image was delivered (untouched, downsampled, cropped, or native resolution). When outputting coordinates, give relative coordinates first and compute absolute coordinates from the original image size. After generating or editing media via commands or scripts, read the result back before continuing.\n- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the `<system>` block, never by measuring the displayed copy. When the `<system>` tag reports downsampling and you need that detail, call this tool again with the `region` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set `full_resolution` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.\n- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.\n- The system will notify you when there is anything wrong when reading the file.\n- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\n- This tool can only read image or video files. To read text files, use the Read tool. To list directories, use `ls` via Bash for a known directory, or Glob for pattern search.\n- If the file doesn't exist or path is invalid, an error will be returned.\n- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.\n- The media content will be returned in a form that you can directly view and understand.\n\n**Capabilities**\n\n- This tool supports image and video files for the current model.",
    parameters: Type.Object(
        {
            path: Type.String({
                description:
                    "Path to an image or video file, or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories and text files are not supported.",
            }),
            region: Type.Optional(
                Type.Object(
                    {
                        x: Type.Integer({
                            minimum: 0,
                            maximum: 9007199254740991,
                            description: "Left edge of the crop, in original-image pixels.",
                        }),
                        y: Type.Integer({
                            minimum: 0,
                            maximum: 9007199254740991,
                            description: "Top edge of the crop, in original-image pixels.",
                        }),
                        width: Type.Integer({
                            minimum: 1,
                            maximum: 9007199254740991,
                            description: "Crop width, in original-image pixels.",
                        }),
                        height: Type.Integer({
                            minimum: 1,
                            maximum: 9007199254740991,
                            description: "Crop height, in original-image pixels.",
                        }),
                    },
                    {
                        description:
                            "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.",
                        additionalProperties: false,
                    },
                ),
            ),
            full_resolution: Type.Optional(
                Type.Boolean({
                    description:
                        "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.",
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
