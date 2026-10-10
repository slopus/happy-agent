//! Standalone native runner startup, authenticated dialling, and bounded reconnects.
use super::*;
use anyhow::Context as _;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use std::{pin::Pin, time::Duration};
use tokio_tungstenite::tungstenite::{
    self, Message, client::IntoClientRequest, protocol::WebSocketConfig,
};

type Writer = Pin<Box<dyn Sink<Message, Error = tungstenite::Error> + Send>>;
type Reader = Pin<Box<dyn Stream<Item = std::result::Result<Message, tungstenite::Error>> + Send>>;
struct Dialled {
    writer: Writer,
    reader: Reader,
}
fn parts<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static>(
    socket: tokio_tungstenite::WebSocketStream<S>,
) -> Dialled {
    let (writer, reader) = socket.split();
    Dialled {
        writer: Box::pin(writer),
        reader: Box::pin(reader),
    }
}

async fn dial(
    settings: &config::RunnerSettings,
    remote: Option<&Arc<tailcat::TailcatConnection>>,
) -> std::result::Result<Dialled, tungstenite::Error> {
    let mut request = settings.endpoint.url().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", settings.token)
            .parse()
            .expect("The validated runner token fits an authorization header."),
    );
    let limits = WebSocketConfig::default()
        .read_buffer_size(4096)
        .write_buffer_size(0)
        .max_write_buffer_size(64 * 1024 * 1024 + 65536)
        .max_message_size(Some(64 * 1024 * 1024))
        .max_frame_size(Some(64 * 1024 * 1024));
    match &settings.endpoint {
        config::RunnerEndpoint::WebSocket(_) => {
            let (socket, _) =
                tokio_tungstenite::connect_async_with_config(request, Some(limits), true).await?;
            Ok(parts(socket))
        }
        config::RunnerEndpoint::Unix { socket, .. } => {
            #[cfg(unix)]
            {
                let stream = tokio::net::UnixStream::connect(socket).await?;
                let (socket, _) =
                    tokio_tungstenite::client_async_with_config(request, stream, Some(limits))
                        .await?;
                Ok(parts(socket))
            }
            #[cfg(not(unix))]
            {
                let _ = socket;
                Err(tungstenite::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "Unix runner sockets are unavailable on this platform.",
                )))
            }
        }
        config::RunnerEndpoint::Tailcat { port, .. } => {
            let stream = remote.unwrap().connect(*port).await.map_err(|_| {
                tungstenite::Error::Io(std::io::Error::other(
                    "The runner's Tailcat connection is unavailable.",
                ))
            })?;
            let (socket, _) =
                tokio_tungstenite::client_async_with_config(request, stream, Some(limits)).await?;
            Ok(parts(socket))
        }
    }
}
async fn connected(server: Arc<owners::RunnerServer>, mut socket: Dialled) -> Result<String> {
    let (incoming, incoming_rx) = tokio::sync::mpsc::channel(32);
    let (outgoing, outgoing_rx) = tokio::sync::mpsc::channel(32);
    let mut outgoing_rx = outgoing_rx;
    let mut work = tokio::spawn(async move {
        server
            .serve(owners::RunnerTransport {
                incoming: incoming_rx,
                outgoing,
            })
            .await
    });
    let pump = async {
        loop {
            tokio::select! {
                output=outgoing_rx.recv()=>match output{Some(frame)=>socket.writer.send(Message::Binary(frame.into())).await?,None=>{socket.writer.close().await?;return Ok::<_,tungstenite::Error>(());}},
                input=socket.reader.next()=>match input {
                    Some(Ok(Message::Binary(bytes)))=>{if incoming.send(bytes.to_vec()).await.is_err(){return Ok(());}},
                    Some(Ok(Message::Ping(bytes)))=>socket.writer.send(Message::Pong(bytes)).await?,
                    Some(Ok(Message::Pong(_)))=>{},
                    Some(Ok(Message::Close(_)))|None=>return Ok(()),
                    Some(Ok(_))=>return Err(tungstenite::Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData,"The daemon sent a non-binary runner message."))),
                    Some(Err(error))=>return Err(error),
                }
            }
        }
    };
    let pumped = pump.await;
    drop(incoming);
    drop(outgoing_rx);
    let result = work.await?;
    if let Err(error) = pumped {
        return Err(error.into());
    }
    result
}

pub async fn run(config: ConfigModule) -> Result<()> {
    process::prepare_child_reaping()?;
    let settings = config.runner_settings()?;
    let config = Arc::new(config);
    let lifecycle = Arc::new(LifecycleModule::new(config.clone())?);
    // These feature modules supply shared kernels; standalone startup never opens their database.
    let runtime = Arc::new(runtime::RuntimeModule::new(config.clone()));
    let events = Arc::new(events::EventsModule::new(runtime.clone())?);
    let usage = Arc::new(usage::UsageModule::new(
        runtime.clone(),
        events.clone(),
        config.clone(),
    )?);
    let history = Arc::new(history::HistoryModule::new(
        config.clone(),
        runtime.clone(),
        events.clone(),
        usage,
    )?);
    let durable = Arc::new(durable::DurableFunctionsModule::new(
        runtime.clone(),
        lifecycle.clone(),
    )?);
    let secrets = secrets::SecretsModule::new(
        config.clone(),
        runtime.clone(),
        durable.clone(),
        events.clone(),
    )?;
    let services = services::ServicesModule::new(
        config.clone(),
        runtime.clone(),
        durable,
        lifecycle.clone(),
        events.clone(),
    )?;
    let runners = owners::RunnersModule::new(config.clone(), runtime.clone(), lifecycle.clone())?;
    let tools = Arc::new(tools::ToolsModule::new(
        config.clone(),
        history,
        lifecycle.clone(),
        runtime,
        secrets,
        services,
        events,
        runners.clone(),
    )?);
    let server = runners.native_server(tools.clone());
    let remote = match &settings.endpoint {
        config::RunnerEndpoint::Tailcat { address, .. } => Some(
            tailcat::TailcatModule::open_runner_remote(&config, address)?,
        ),
        _ => None,
    };
    let signal_lifecycle = lifecycle.clone();
    let signal = tokio::spawn(async move {
        #[cfg(unix)]
        {
            if let Ok(mut terminated) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminated.recv()=>{}}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        signal_lifecycle.begin_shutdown();
    });
    let identity = config.runner_identity()?;
    eprintln!(
        "Happy Agent runner {} on {} is starting.",
        identity["version"].as_str().unwrap(),
        identity["hostname"].as_str().unwrap()
    );
    let mut delay = 1000u64;
    while !lifecycle.shutdown.is_cancelled() {
        let started = tokio::time::Instant::now();
        let connection = tokio::select! {_=lifecycle.shutdown.cancelled()=>break,result=tokio::time::timeout(Duration::from_secs(20),dial(&settings,remote.as_ref()))=>result};
        match connection {
            Ok(Ok(socket)) => {
                eprintln!("Connected to the daemon.");
                match connected(server.clone(), socket).await {
                    Ok(reason) => eprintln!("The connection to the daemon ended: {reason}"),
                    Err(_) => eprintln!("The connection to the daemon ended unexpectedly."),
                };
                if started.elapsed() >= Duration::from_secs(60) {
                    delay = 1000;
                }
            }
            Ok(Err(tungstenite::Error::Http(response))) => {
                let status = response.status().as_u16();
                match status {
                    401 => {
                        eprintln!("The daemon refused this runner's token.");
                        delay = 60000;
                    }
                    404 => {
                        eprintln!(
                            "The daemon does not accept runners. It may be older than this runner, or have no runners configured."
                        );
                        delay = 60000;
                    }
                    _ => eprintln!("The daemon answered with HTTP {status}."),
                }
            }
            _ => eprintln!("The daemon could not be reached."),
        }
        let jitter = 0.8 + rand::random::<f64>() * 0.4;
        tokio::select! {_=lifecycle.shutdown.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis((delay as f64*jitter).round() as u64))=>{}}
        delay = (delay * 2).min(30000);
    }
    let released = server.close().await;
    tools.close().await;
    if let Some(remote) = remote {
        remote.close().await?;
    }
    signal.abort();
    let _ = signal.await;
    released
}
