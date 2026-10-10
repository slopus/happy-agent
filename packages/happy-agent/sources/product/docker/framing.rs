//! A bounded stream carrier for the existing runner's binary frames.
use anyhow::{Result, ensure};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
const LIMIT: usize = 64 * 1024 * 1024;
pub(super) async fn read<R: AsyncRead + Unpin>(
    mut input: R,
    output: mpsc::Sender<Vec<u8>>,
) -> Result<()> {
    loop {
        let length = match input.read_u32().await {
            Ok(length) => length as usize,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            length > 0 && length <= LIMIT,
            "The container worker frame exceeds its byte bound."
        );
        let mut frame = vec![0; length];
        input.read_exact(&mut frame).await?;
        if output.send(frame).await.is_err() {
            return Ok(());
        }
    }
}
pub(super) async fn write<W: AsyncWrite + Unpin>(
    mut output: W,
    mut input: mpsc::Receiver<Vec<u8>>,
) -> Result<()> {
    while let Some(frame) = input.recv().await {
        ensure!(
            !frame.is_empty() && frame.len() <= LIMIT,
            "The container worker frame exceeds its byte bound."
        );
        output.write_u32(frame.len() as u32).await?;
        output.write_all(&frame).await?;
        output.flush().await?;
    }
    output.shutdown().await?;
    Ok(())
}
