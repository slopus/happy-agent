import type { SessionTool } from "@/core/SessionTool.js";
import { run_terminal_command } from "@/vendors/grok/tools/run_terminal_command.js";
import { read_file } from "@/vendors/grok/tools/read_file.js";
import { search_replace } from "@/vendors/grok/tools/search_replace.js";
import { list_dir } from "@/vendors/grok/tools/list_dir.js";
import { grep } from "@/vendors/grok/tools/grep.js";
import { kill_command_or_subagent } from "@/vendors/grok/tools/kill_command_or_subagent.js";
import { todo_write } from "@/vendors/grok/tools/todo_write.js";
import { get_command_or_subagent_output } from "@/vendors/grok/tools/get_command_or_subagent_output.js";
import { spawn_subagent } from "@/vendors/grok/tools/spawn_subagent.js";
import { scheduler_create } from "@/vendors/grok/tools/scheduler_create.js";
import { scheduler_delete } from "@/vendors/grok/tools/scheduler_delete.js";
import { scheduler_list } from "@/vendors/grok/tools/scheduler_list.js";
import { monitor } from "@/vendors/grok/tools/monitor.js";
import { search_tool } from "@/vendors/grok/tools/search_tool.js";
import { use_tool } from "@/vendors/grok/tools/use_tool.js";
import { workflow } from "@/vendors/grok/tools/workflow.js";
import { enter_plan_mode } from "@/vendors/grok/tools/enter_plan_mode.js";
import { exit_plan_mode } from "@/vendors/grok/tools/exit_plan_mode.js";
import { ask_user_question } from "@/vendors/grok/tools/ask_user_question.js";
import { web_search } from "@/vendors/grok/tools/web_search.js";
import { web_fetch } from "@/vendors/grok/tools/web_fetch.js";
import { image_gen } from "@/vendors/grok/tools/image_gen.js";
import { image_edit } from "@/vendors/grok/tools/image_edit.js";
import { image_to_video } from "@/vendors/grok/tools/image_to_video.js";
import { reference_to_video } from "@/vendors/grok/tools/reference_to_video.js";
import { write } from "@/vendors/grok/tools/write.js";
import { hosted_web_search } from "@/vendors/grok/tools/hosted_web_search.js";
import { hosted_x_search } from "@/vendors/grok/tools/hosted_x_search.js";

/**
 * Search that Grok's backend performs itself, declared by type alone.
 *
 * Kept apart from `grok_4_5_tools`, which is a literal capture of the tools CLI 0.2.111 sent.
 * These are what current Grok sends, and what gives a caller live web and X results.
 */
export const grok_hosted_tools: readonly SessionTool[] = [hosted_web_search, hosted_x_search];

export const grok_4_5_tools: readonly SessionTool[] = [
    run_terminal_command,
    read_file,
    search_replace,
    list_dir,
    grep,
    kill_command_or_subagent,
    todo_write,
    get_command_or_subagent_output,
    spawn_subagent,
    scheduler_create,
    scheduler_delete,
    scheduler_list,
    monitor,
    search_tool,
    use_tool,
    workflow,
    enter_plan_mode,
    exit_plan_mode,
    ask_user_question,
    web_search,
    web_fetch,
    image_gen,
    image_edit,
    image_to_video,
    reference_to_video,
    write,
];
