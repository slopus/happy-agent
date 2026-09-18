# System prompt learnings

## Windows guidance must describe the executing shell

Agent configuration captured `SHELL`, which is commonly absent on Windows or inherited from Git
Bash. Native Compute always runs Windows PowerShell 5.1, so Windows prompts name that actual
default on every inference, including for existing agents. Guidance covers PowerShell quoting,
environment variables, exit checks, file paths, and hidden background helpers. Claude exposes
PowerShell on native Windows; Codex keeps exec_command. Bash belongs to Unix/WSL environments,
and native Windows does not support Git Bash. Tool descriptions must agree with this executor.
