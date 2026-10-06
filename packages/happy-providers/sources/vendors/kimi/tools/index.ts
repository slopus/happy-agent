import { kimi_bash_tool } from "@/vendors/kimi/tools/bash.js";
import { kimi_read_tool } from "@/vendors/kimi/tools/read.js";
import { kimi_write_tool } from "@/vendors/kimi/tools/write.js";
import { kimi_edit_tool } from "@/vendors/kimi/tools/edit.js";
import { kimi_glob_tool } from "@/vendors/kimi/tools/glob.js";
import { kimi_grep_tool } from "@/vendors/kimi/tools/grep.js";
import { kimi_read_media_file_tool } from "@/vendors/kimi/tools/read_media_file.js";

export const kimi_tools = [
    kimi_bash_tool,
    kimi_read_tool,
    kimi_write_tool,
    kimi_edit_tool,
    kimi_glob_tool,
    kimi_grep_tool,
    kimi_read_media_file_tool,
] as const;
