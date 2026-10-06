# GLM compute tools

GLM uses an explicit Claude-shaped array because its official coding harness uses Claude Code.
The ordinary array contains the existing Claude shell and file tools, with claudeTextReadTool
in place of the image-capable reader. The reviewer array makes the same reader choice.

Read retains file_path, offset, and limit. Image paths return a clear text-only unsupported result
before image bytes are read, so no image block enters GLM's text-only inference history. The other
tools retain their existing execution and permission behavior, including PowerShell names on
native Windows. Selection uses the GLM model family; no inference-loop capability probe is added.
