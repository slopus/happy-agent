use super::*;
use crate::product::tools::commands::Snapshot;

impl ToolsModule {
    pub(super) async fn vendor_shell(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        tool: &NativeTool,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Block>, bool)> {
        match tool.implementation {
            I::ClaudeBash | I::GrokCommand | I::KimiBash => {
                let background = args["run_in_background"] == true || args["background"] == true;
                let wait = if background {
                    3000
                } else {
                    match tool.implementation {
                        I::KimiBash => args["timeout"].as_u64().unwrap_or(60) * 1000,
                        I::GrokCommand => match args["timeout"].as_u64() {
                            Some(value) if value > 0 => value,
                            _ => 120_000,
                        },
                        _ => args["timeout"].as_f64().unwrap_or(120_000.0) as u64,
                    }
                };
                let mut command = json!({"cmd":args["command"],"tty":args["tty"]==true});
                if let Some(cwd) = args.get("cwd") {
                    command["workdir"] = cwd.clone();
                }
                if let Some(secrets) = args.get("secrets") {
                    command["secrets"] = secrets.clone();
                }
                let snapshot = self
                    .commands
                    .start_snapshot(
                        agent,
                        configuration,
                        mode,
                        &command,
                        wait,
                        512_000,
                        cancel.clone(),
                    )
                    .await?;
                let (value, text, error) = match tool.implementation {
                    I::ClaudeBash => claude_start(&snapshot),
                    I::KimiBash => kimi_start(&snapshot),
                    _ => grok_start(&snapshot),
                };
                self.surface_result(tool, &value)?;
                Ok((vec![Block::text(text)], error))
            }
            I::GrokOutput => {
                let mut ids = Vec::new();
                for task in args["task_ids"].as_array().unwrap() {
                    let task = task.as_str().unwrap().trim();
                    if !task.is_empty() && !ids.iter().any(|(id, _)| id == task) {
                        ids.push((task.to_owned(), self.parse_vendor_session(V::Grok, task)?));
                    }
                }
                ensure!(!ids.is_empty(), "Provide at least one task ID.");
                let deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_millis(args["timeout_ms"].as_u64().unwrap_or(0));
                let mut results = Vec::new();
                let mut texts = Vec::new();
                for (task, id) in ids {
                    if !self.commands.contains(agent, id) {
                        results.push(json!({"task_id":task,"status":"not_found","output":"","truncated":false}));
                        texts.push(format!(
                            "Task {task} is not a background command on this machine."
                        ));
                        continue;
                    }
                    let wait = deadline
                        .saturating_duration_since(tokio::time::Instant::now())
                        .as_millis() as u64;
                    let snapshot = self
                        .commands
                        .input_snapshot(agent, id, mode, &json!({}), wait, cancel.clone())
                        .await?;
                    let (output, truncated) = bounded(&snapshot.produced(), 40_000, true);
                    let mut result = json!({"task_id":task,"command":snapshot.command,"status":snapshot.status(),"output":output,"truncated":truncated});
                    if snapshot.finished {
                        result["exit_code"] = json!(snapshot.exit);
                    }
                    let heading = if !snapshot.finished {
                        format!("Task {task} is still running: {}", snapshot.command)
                    } else if let Some(code) = snapshot.exit {
                        format!(
                            "Task {task} has ended with exit code {code}: {}",
                            snapshot.command
                        )
                    } else {
                        format!(
                            "Task {task} has ended without an exit code, which is what a stopped command looks like: {}",
                            snapshot.command
                        )
                    };
                    texts.push(format!(
                        "{heading}\n{}",
                        if output.is_empty() {
                            "(no new output)"
                        } else {
                            &output
                        }
                    ));
                    results.push(result);
                }
                self.surface_result(tool, &json!({"results":results}))?;
                Ok((vec![Block::text(texts.join("\n\n"))], false))
            }
            I::ClaudeOutput | I::ClaudeInput | I::GrokInput | I::KimiOutput | I::KimiInput => {
                let vendor = tool.vendor.unwrap();
                let task = args["bash_id"]
                    .as_str()
                    .or_else(|| args["task_id"].as_str())
                    .unwrap();
                let id = self.parse_vendor_session(vendor, task)?;
                let typing = matches!(
                    tool.implementation,
                    I::ClaudeInput | I::GrokInput | I::KimiInput
                );
                let wait = match tool.implementation {
                    I::KimiOutput => 0,
                    I::ClaudeOutput if args["block"] == false => 0,
                    I::ClaudeOutput => args["timeout"].as_f64().unwrap_or(30_000.0) as u64,
                    I::GrokInput => args["timeout_ms"].as_u64().unwrap_or(250),
                    _ => args["timeout"].as_f64().unwrap_or(250.0) as u64,
                };
                let snapshot = self
                    .commands
                    .input_snapshot(
                        agent,
                        id,
                        mode,
                        &json!({"chars":if typing{args["input"].as_str().unwrap()}else{""}}),
                        wait,
                        cancel.clone(),
                    )
                    .await?;
                let maximum = if vendor == V::Kimi { 60_000 } else { 40_000 };
                let (output, truncated) = bounded(&snapshot.produced(), maximum, vendor != V::Kimi);
                let mut result = if vendor == V::Grok {
                    json!({"task_id":task,"status":snapshot.status(),"output":output,"truncated":truncated})
                } else if vendor == V::Kimi {
                    json!({"task_id":snapshot.session.to_string(),"status":snapshot.status(),"output":output,"truncated":truncated||snapshot.dropped>0})
                } else {
                    json!({"bash_id":task,"command":snapshot.command,"status":snapshot.status(),"output":output,"truncated":truncated||snapshot.dropped>0})
                };
                if snapshot.finished {
                    result[if vendor == V::Claude || vendor == V::Glm {
                        "exitCode"
                    } else {
                        "exit_code"
                    }] = json!(snapshot.exit);
                }
                let heading = match tool.implementation {
                    I::ClaudeOutput => {
                        result["retrieval_status"] = json!(if snapshot.finished {
                            "success"
                        } else if args["block"] == false {
                            "not_ready"
                        } else {
                            "timeout"
                        });
                        if !snapshot.finished {
                            format!(
                                "Background shell {task} is still running: {}",
                                snapshot.command
                            )
                        } else if let Some(code) = snapshot.exit {
                            format!(
                                "Background shell {task} exited with code {code}: {}",
                                snapshot.command
                            )
                        } else {
                            format!("Background shell {task} was stopped: {}", snapshot.command)
                        }
                    }
                    I::ClaudeInput => format!(
                        "Background shell {task} {}.",
                        if snapshot.finished {
                            "has finished"
                        } else {
                            "is still running"
                        }
                    ),
                    I::GrokInput => {
                        if !snapshot.finished {
                            format!("Task {task} is still running.")
                        } else if let Some(code) = snapshot.exit {
                            format!("Task {task} has ended with exit code {code}.")
                        } else {
                            format!(
                                "Task {task} has ended without an exit code, which is what a stopped command looks like."
                            )
                        }
                    }
                    I::KimiOutput => format!(
                        "Shell task {}: {}{}.",
                        snapshot.session,
                        snapshot.status(),
                        if snapshot.finished {
                            format!(
                                "; exit code {}",
                                snapshot
                                    .exit
                                    .map_or_else(|| "null".into(), |code| code.to_string())
                            )
                        } else {
                            String::new()
                        }
                    ),
                    _ => format!("Shell task {}: {}.", snapshot.session, snapshot.status()),
                };
                self.surface_result(tool, &result)?;
                Ok((
                    vec![Block::text(format!(
                        "{heading}\n{}",
                        if output.is_empty() {
                            "(no new output)"
                        } else {
                            &output
                        }
                    ))],
                    false,
                ))
            }
            I::ClaudeStop | I::GrokStop | I::KimiStop => {
                let vendor = tool.vendor.unwrap();
                let task = args["bash_id"]
                    .as_str()
                    .or_else(|| args["task_id"].as_str())
                    .unwrap();
                let id = self.parse_vendor_session(vendor, task)?;
                if vendor == V::Grok && !self.commands.contains(agent, id) {
                    let text = format!("Task {task} is not a background command on this machine.");
                    self.surface_result(
                        tool,
                        &json!({"task_id":task,"outcome":"not_found","message":text}),
                    )?;
                    return Ok((vec![Block::text(text)], false));
                }
                let (command, stopped) = self.commands.stop(agent, id).await?;
                let (value, text) = if vendor == V::Grok {
                    let text = if stopped {
                        format!("Stopped task {task}: {command}")
                    } else {
                        format!("Task {task} had already ended: {command}")
                    };
                    (
                        json!({"task_id":task,"command":command,"outcome":if stopped{"stopped"}else{"already_ended"},"message":text}),
                        text,
                    )
                } else if vendor == V::Kimi {
                    (
                        json!({"task_id":task,"stopped":stopped}),
                        if stopped {
                            format!("Stopped shell task {task}.")
                        } else {
                            format!("Shell task {task} had already ended.")
                        },
                    )
                } else {
                    (
                        json!({"bash_id":task,"command":command,"stopped":stopped}),
                        if stopped {
                            format!("Stopped background shell {task}: {command}")
                        } else {
                            format!("Background shell {task} had already ended: {command}")
                        },
                    )
                };
                self.surface_result(tool, &value)?;
                Ok((vec![Block::text(text)], false))
            }
            _ => anyhow::bail!("The requested shell tool is unavailable."),
        }
    }
}

fn claude_start(snapshot: &Snapshot) -> (Value, String, bool) {
    let (stdout, out_truncated) = bounded(&snapshot.stdout, 40_000, true);
    let (stderr, err_truncated) = bounded(&snapshot.stderr, 40_000, true);
    let mut value = json!({"command":snapshot.command,"stdout":stdout,"stderr":stderr,"truncated":out_truncated||err_truncated||snapshot.dropped>0,"wallTimeSeconds":(snapshot.wall_time*1000.0).round()/1000.0});
    let mut parts = vec![stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if !snapshot.finished {
        value["bash_id"] = json!(snapshot.session.to_string());
        parts.push(format!("The command is still running as background shell {}. Read its new output with BashOutput, type into it with BashInput, and stop it with BashStop.",snapshot.session));
    } else {
        value["exitCode"] = json!(snapshot.exit);
        if let Some(code) = snapshot.exit {
            if code != 0 {
                parts.push(format!("The command exited with code {code}."));
            }
        } else {
            parts.push("The command was stopped before it could exit.".into());
        }
    }
    (
        value,
        if parts.is_empty() {
            "(no output)".into()
        } else {
            parts.join("\n")
        },
        snapshot.finished && snapshot.exit != Some(0),
    )
}
fn kimi_start(snapshot: &Snapshot) -> (Value, String, bool) {
    let (stdout, a) = bounded(&snapshot.stdout, 60_000, false);
    let (stderr, b) = bounded(&snapshot.stderr, 60_000, false);
    let mut value = json!({"stdout":stdout,"stderr":stderr,"truncated":a||b||snapshot.dropped>0});
    let mut parts = vec![stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if !snapshot.finished {
        value["task_id"] = json!(snapshot.session.to_string());
        parts.push(format!("Task {} keeps running in the background. Completion will be reported automatically. Use TaskOutput for new output, TaskInput for stdin, and TaskStop to cancel it.",snapshot.session));
    } else {
        value["exit_code"] = json!(snapshot.exit);
        if let Some(code) = snapshot.exit {
            if code != 0 {
                parts.push(format!("Command failed with exit code: {code}"));
            }
        } else {
            parts.push("Command was stopped before it exited.".into());
        }
    }
    (
        value,
        if parts.is_empty() {
            "Command executed successfully.".into()
        } else {
            parts.join("\n")
        },
        snapshot.finished && snapshot.exit != Some(0),
    )
}
fn grok_start(snapshot: &Snapshot) -> (Value, String, bool) {
    let (output, _) = bounded(&snapshot.produced(), 40_000, true);
    let output = if snapshot.dropped > 0 {
        format!(
            "[The machine dropped {} bytes of this command's output as it ran.]\n{output}",
            snapshot.dropped
        )
    } else {
        output
    };
    if !snapshot.finished {
        let text=[output,format!("Command still running in the background with task_id {}. Read it with get_command_or_subagent_output, type into it with send_command_input, or stop it with kill_command_or_subagent.",snapshot.session)].into_iter().filter(|part|!part.is_empty()).collect::<Vec<_>>().join("\n\n");
        return (
            json!({"text":text,"task_id":snapshot.session.to_string()}),
            text,
            false,
        );
    }
    let output = if output.is_empty() {
        "(no output)".into()
    } else {
        output
    };
    let error = snapshot.exit.is_some_and(|code| code != 0);
    let text = if error {
        format!(
            "{output}\n\nCommand exited with code {}.",
            snapshot.exit.unwrap()
        )
    } else {
        output
    };
    (json!({"text":text}), text, error)
}
pub(in crate::product::tools) fn bounded(text: &str, maximum: usize, tail: bool) -> (String, bool) {
    let count = text.encode_utf16().count();
    if count <= maximum {
        return (text.into(), false);
    }
    let omitted = count - maximum;
    let characters = if tail {
        let mut units = 0;
        let mut result = Vec::new();
        for character in text.chars().rev() {
            if units + character.len_utf16() > maximum {
                break;
            }
            units += character.len_utf16();
            result.push(character);
        }
        result.into_iter().rev().collect::<String>()
    } else {
        let mut units = 0;
        text.chars()
            .take_while(|character| {
                units += character.len_utf16();
                units <= maximum
            })
            .collect()
    };
    (
        if tail {
            format!(
                "[Earlier output was truncated: {omitted} characters are not shown.]\n{characters}"
            )
        } else {
            format!(
                "{characters}\n[Output was truncated: {omitted} further characters are not shown.]"
            )
        },
        true,
    )
}
