# Antigravity compute tools

Happy runs Antigravity (`agy acp`) as a custom agent with none of agy's own file, terminal,
browser or sub-agent tools; only its web search remains. Antigravity therefore works the machine
through this array alone, served to it over Happy's MCP bridge, so every read, write and command
runs in Happy's sandbox under Happy's permission mode and reviewer.

The array is Claude-shaped: Bash with BashOutput, BashInput and BashStop for background commands,
Read (images included), Write, Edit, Glob and Grep, built from the Claude tool definitions as GLM's
is. Gemini has no harness surface of its own to match, and these are the most widely known names.
Bash's `dangerouslyDisableSandbox` requests one reviewed Full-access run in Auto, as for Claude.

Selection is by the `antigravity/` model ID prefix. Other foreign harnesses keep `[]`, because
they bring their own tools.
