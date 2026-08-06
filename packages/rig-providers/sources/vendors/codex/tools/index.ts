import type { SessionTool } from "@/core/SessionTool.js";

export { apply_patch } from "./apply_patch.js";
export { exec } from "./exec.js";
export { exec_command } from "./exec_command.js";
export { followup_task } from "./followup_task.js";
export { imagegen } from "./imagegen.js";
export { interrupt_agent } from "./interrupt_agent.js";
export { list_agents } from "./list_agents.js";
export { list_mcp_resource_templates } from "./list_mcp_resource_templates.js";
export { list_mcp_resources } from "./list_mcp_resources.js";
export { read_mcp_resource } from "./read_mcp_resource.js";
export { request_plugin_install } from "./request_plugin_install.js";
export { request_user_input } from "./request_user_input.js";
export { send_message } from "./send_message.js";
export { spawn_agent } from "./spawn_agent.js";
export { tool_search } from "./tool_search.js";
export { update_plan } from "./update_plan.js";
export { view_image } from "./view_image.js";
export { wait } from "./wait.js";
export { wait_agent } from "./wait_agent.js";
import { web_search } from "./web_search.js";

export { web_search };

/**
 * Tools OpenAI runs on its own backend inside a single response.
 *
 * Named the same way Grok's are, because the product decides which searches an agent holds without
 * knowing whose backend answers them.
 */
export const codex_hosted_tools = [web_search] as const satisfies readonly SessionTool[];
export { write_stdin } from "./write_stdin.js";
