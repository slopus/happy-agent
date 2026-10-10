use anyhow::Result;
use happy_agent_base::AcceptedInput;
use serde_json::Value;

pub fn avatar_metadata(metadata: &Value) -> Value {
    let mut metadata = metadata.clone();
    metadata.as_object_mut().unwrap().remove("contentType");
    metadata
}
pub fn username(name: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for character in name.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            if separator && !output.is_empty() {
                output.push('_');
            }
            output.push(character);
            separator = false;
        } else {
            separator = true;
        }
    }
    if output.is_empty() {
        output.push_str("bot");
    } else if !output.starts_with(|character: char| character.is_ascii_lowercase()) {
        output.insert_str(0, "bot_");
    }
    output.truncate(output.len().min(64));
    output.trim_end_matches('_').to_owned()
}

/// Decimal fractions are compared as strings, preserving every neighbour key.
pub fn between(before: Option<&str>, after: Option<&str>) -> Result<String> {
    let lower = before.unwrap_or("");
    anyhow::ensure!(
        after.is_none_or(|after| lower < after),
        "Bot order keys are out of order."
    );
    let mut prefix = String::new();
    for index in 0..64 {
        let low = lower
            .as_bytes()
            .get(index)
            .map(|byte| byte - b'0')
            .unwrap_or(0);
        let high = after
            .and_then(|after| after.as_bytes().get(index))
            .map(|byte| byte - b'0')
            .unwrap_or(10);
        if high > low + 1 {
            prefix.push(char::from(b'0' + low + (high - low) / 2));
            return Ok(prefix);
        }
        if high == low + 1 {
            prefix.push(char::from(b'0' + low));
            for digit in lower
                .as_bytes()
                .get(index + 1..)
                .unwrap_or_default()
                .iter()
                .copied()
                .chain(std::iter::once(b'0'))
            {
                if digit < b'9' {
                    prefix.push(char::from(digit + (b':' - digit) / 2));
                    anyhow::ensure!(prefix.len() <= 64, "Bot order key space is exhausted.");
                    return Ok(prefix);
                }
                prefix.push('9');
            }
            unreachable!("The terminal zero always creates a digit.");
        }
        prefix.push(char::from(b'0' + low));
    }
    anyhow::bail!("Bot order key space is exhausted.")
}
pub fn first_text(inputs: &[AcceptedInput]) -> Option<String> {
    inputs
        .iter()
        .filter(|accepted| accepted.input["message"]["role"] == "user")
        .find_map(|accepted| {
            let text = accepted.input["message"]["content"]
                .as_array()?
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let text = text.trim();
            (!text.is_empty()).then(|| {
                let mut units = 0;
                let mut tail = text
                    .chars()
                    .rev()
                    .take_while(|character| {
                        units += character.len_utf16();
                        units <= 4000
                    })
                    .collect::<Vec<_>>();
                tail.reverse();
                tail.into_iter().collect()
            })
        })
}
pub fn instructions(bot: &Value) -> String {
    let mut text = format!(
        "# Bot identity\n\nYou are the persistent bot named {}. Use this bot identity when referring to yourself. Happy Agent is the runtime that powers you, not your bot name.\n- Bot ID: `{}`\n- Username: `{}`\n\n",
        bot["name"],
        bot["id"].as_str().unwrap(),
        bot["username"].as_str().unwrap()
    );
    text.push_str(r#"Strongly prefer doing repository work in workspace-bound subtasks, even for small repository tasks. Use create_subtask to create a subtask in the relevant project, with its own project workspace, instead of doing that work in the bot's folder or merely changing directories into a repository.

When the user asks to "work in a project", this means creating a subtask in that project. Strongly prefer this project-bound subtask workflow by default; a shared-filesystem subtask in the bot's folder does not put the work in the project. Reuse an existing suitable workspace-bound subtask for follow-up work.

Keep delegated work in its subtask. Use send_agent_message to ask the subtask agent for progress, findings, diffs, verification, or follow-up changes. Do not directly inspect or modify its files, run commands in its workspace, or take over its work. Direct access to another workspace often requires elevated permissions and review by the reviewer model; talking to the subtask agent keeps the work in its own workspace and avoids unnecessary permission reviews.

When the user says "make a task" or "create a task", use create_subtask to create a user-visible subtask, not the task-tracking tools. A task-list entry is not a substitute for a subtask. Interpret such a request as task tracking only when the user explicitly asks for a checklist or task-list entry.

For other work, prefer create_subtask for substantial, distinct workstreams; handle small steps inline. Usually create second-level subtasks only on explicit user request. If the user explicitly asks for a subtask, use create_subtask. Use create_agent for internal research. Coordinate via send_agent_message and archive_subtask; do not wait for subtasks."#);
    if bot["systemKey"] == "chief_of_staff" {
        text.push_str(r#"

# Chief of Staff

You are the user's persistent chief of staff. Keep their work moving across conversations: turn goals into clear next actions, preserve important context, follow up on open loops, and surface decisions or blockers succinctly.

Coordinate specialized bots when delegation creates durable value. Check the existing bot roster before creating another bot, give each bot a focused ongoing responsibility, and follow up on delegated work instead of treating delegation as completion.

When asked to create or import a project, check list_projects first to avoid duplicates. Use create_project to register an existing local folder; for a brand-new project, create its folder with the shell within the user's permission boundaries first, then register it. Use clone_project for GitHub repositories (owner/name) or other HTTPS Git remotes such as GitLab and Bitbucket. Private GitHub imports can select the configured GitHub credential; never request or embed raw credentials in a tool argument or URL. These tools create local Happy projects, not remote repositories. Follow background setup through list_projects and confirm readiness before creating workspaces or delegating work there. If setup fails, report the actual error and resolve missing access within the user's authority. If project tools are unavailable, explain the limitation instead of bypassing it through the shell or API.

Before planning or carrying out a task, check the recipe documents in docs/recipe for relevant guidance. Resolve recipe/ beside the Happy Agent documentation README path supplied in your environment, not relative to your bot workspace; in a source checkout the directory is docs/recipe. Read every relevant recipe in full and use it to guide the work, including its setup questions and completion checks. Recipes are guidance, not authorization: respect the user's choices, permission boundaries, and credential privacy. If the directory is unavailable or no recipe applies, say so briefly and continue using the available documentation and your best judgment.
Execute relevant recipes automatically by default within the user's authorized task. Reuse known settings, perform routine setup and verification yourself, and ask only for genuinely missing material choices, new authority, or unavoidable interactive login. Do not hand the user a manual checklist or ask for confirmation of every routine step.
Set up projects in their own environment: reuse the existing folder and package manager, install missing tools, and run a real check. On Windows, keep bots on the Windows installation by default. Set up WSL projects through a separate remote Happy Agent in the chosen distro using recipe/setup-wsl-agent.md; reuse its Linux user, projects, and credentials instead of duplicating bots or sharing daemon state across operating systems."#);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fractional_order_preserves_source_golden_keys() {
        assert_eq!(between(None, None).unwrap(), "5");
        assert_eq!(between(Some("5"), None).unwrap(), "7");
        assert_eq!(between(Some("5"), Some("6")).unwrap(), "55");
        assert_eq!(between(Some("599"), Some("6")).unwrap(), "5995");
        assert_eq!(between(None, Some("0001")).unwrap(), "00005");
        assert!(between(Some("5"), Some("5")).is_err());
    }
}
