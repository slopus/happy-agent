use happy_agent_base::{Agent, AgentConfig, AgentEvent, DeliveryOptions, persistence::Store};
use happy_providers::{
    Event, HttpSession, Message, ProviderConfig, RunRequest, Session, ToolDefinition,
};
use serde::Deserialize;
use std::{ffi::OsString, path::PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const MAX_INPUT: usize = 32 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inference {
    #[serde(default = "session_id")]
    session_id: String,
    #[serde(default)]
    tools: Vec<ToolDefinition>,
    request: RunRequest,
}
fn session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Send {
        message: Message,
        #[serde(default)]
        options: DeliveryOptions,
    },
    Steer {
        message: Message,
        #[serde(default)]
        options: DeliveryOptions,
    },
    Abort,
    Compact {
        #[serde(default)]
        instructions: Option<String>,
    },
    Status,
    Drain,
    Close,
}

pub async fn run(command: OsString, arguments: Vec<OsString>) -> anyhow::Result<()> {
    let mut config = None;
    let mut store = None;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        if argument == "--config" {
            config =
                Some(PathBuf::from(arguments.next().ok_or_else(|| {
                    anyhow::anyhow!("--config requires a file path.")
                })?));
        } else if argument == "--store" {
            store = Some(PathBuf::from(arguments.next().ok_or_else(|| {
                anyhow::anyhow!("--store requires a database path.")
            })?));
        } else {
            anyhow::bail!("Unknown argument: {}", argument.to_string_lossy());
        }
    }
    let config = config
        .ok_or_else(|| anyhow::anyhow!("Select a provider configuration with --config <file>."))?;
    let bytes = read_bounded_file(config).await?;
    if command == "infer" {
        let config: ProviderConfig = serde_json::from_slice(&bytes)?;
        let mut input = Vec::new();
        tokio::io::stdin()
            .take(MAX_INPUT as u64 + 1)
            .read_to_end(&mut input)
            .await?;
        anyhow::ensure!(input.len() <= MAX_INPUT, "Inference input exceeds 32 MiB.");
        let input: Inference = serde_json::from_slice(&input)?;
        let mut session = HttpSession::new(input.session_id, config, input.tools).await?;
        let (sender, mut receiver) = tokio::sync::mpsc::channel(128);
        let cancel = CancellationToken::new();
        let inference = session.run(input.request, cancel.clone(), sender);
        tokio::pin!(inference);
        let mut ended = false;
        let mut error = None;
        loop {
            tokio::select! {
                _=tokio::signal::ctrl_c()=>cancel.cancel(),
                _=&mut inference,if !ended=>ended=true,
                event=receiver.recv()=>{ let Some(event)=event else { break; }; if let Event::Done { outcome:happy_providers::Outcome::Error { error:failure } }=&event { error=Some(failure.message.clone()); } write_json(&event).await?; },
            }
        }
        if let Some(error) = error {
            anyhow::bail!("{error}");
        }
        return Ok(());
    }
    if command != "agent" {
        anyhow::bail!(
            "Unknown command: {}. Run happy-agent --help for the migrated commands.",
            command.to_string_lossy()
        );
    }
    let config: AgentConfig = serde_json::from_slice(&bytes)?;
    let store =
        Store::open(store.ok_or_else(|| {
            anyhow::anyhow!("The agent command requires --store <database file>.")
        })?)
        .await?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel(256);
    // Product tools remain outside the minimal base. No shell or SDK process is bundled here.
    let agent = Agent::native(store.clone(), config, Vec::new(), sender).await?;
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    let mut eof = false;
    write_json(&serde_json::json!({"type":"ready"})).await?;
    loop {
        if eof && !agent.is_active().await? {
            break;
        }
        tokio::select! {
            error=agent.wait_failure()=>return Err(error.into()),
            _=tokio::signal::ctrl_c()=>agent.abort(),
            line=read_line(&mut input),if !eof=>{
                let line=line?; if line.is_empty() { eof=true; continue; }
                let control:Control=match serde_json::from_slice(&line) { Ok(control)=>control,Err(error)=>{ write_json(&serde_json::json!({"type":"input_error","message":format!("Invalid agent command: {error}")})).await?; continue; } };
                match control {
                    Control::Send { message,options }=>write_json(&agent.send(message,options).await?).await?,
                    Control::Steer { message,options }=>write_json(&agent.steer(message,options).await?).await?,
                    Control::Abort=>{ agent.abort(); write_json(&serde_json::json!({"type":"abort_requested"})).await?; },
                    Control::Compact { instructions }=>agent.compact(instructions).await?,
                    Control::Status=>write_json(&serde_json::json!({"type":"status","active":agent.is_active().await?})).await?,
                    Control::Drain=>{ finish(agent, &mut receiver, false).await?; store.close().await?; return Ok(()); },
                    Control::Close=>{ finish(agent, &mut receiver, true).await?; store.close().await?; return Ok(()); },
                }
            },
            event=receiver.recv()=>{ if let Some(event)=event { write_json(&event).await?; if matches!(event,AgentEvent::Settled { .. }) && eof && !agent.is_active().await? { break; } } },
        }
    }
    finish(agent, &mut receiver, false).await?;
    store.close().await?;
    Ok(())
}
async fn finish(
    agent: Agent,
    receiver: &mut tokio::sync::mpsc::Receiver<AgentEvent>,
    close: bool,
) -> anyhow::Result<()> {
    let shutdown = async {
        if close {
            agent.close().await
        } else {
            agent.drain().await
        }
    };
    tokio::pin!(shutdown);
    // Keep consuming while the worker joins, including events sent after its idle transaction.
    loop {
        tokio::select! {
            result = &mut shutdown => { result?; break; },
            event = receiver.recv() => { if let Some(event) = event { write_json(&event).await?; } },
        }
    }
    while let Ok(event) = receiver.try_recv() {
        write_json(&event).await?;
    }
    Ok(())
}
async fn write_json(value: &impl serde::Serialize) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    let mut output = tokio::io::stdout();
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}
async fn read_bounded_file(path: PathBuf) -> anyhow::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    anyhow::ensure!(bytes.len() <= MAX_INPUT, "Configuration exceeds 32 MiB.");
    Ok(bytes)
}
async fn read_line(reader: &mut tokio::io::BufReader<tokio::io::Stdin>) -> anyhow::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(line);
        }
        let end = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        anyhow::ensure!(line.len() + end <= MAX_INPUT, "Agent input exceeds 32 MiB.");
        line.extend_from_slice(&available[..end]);
        let done = available[end - 1] == b'\n';
        reader.consume(end);
        if done {
            return Ok(line);
        }
    }
}
