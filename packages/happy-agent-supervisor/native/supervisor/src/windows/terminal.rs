use super::handles::{pipe, raw};
use std::{
    fs::File,
    io,
    sync::{Arc, Mutex},
};
use tokio::fs::File as AsyncFile;
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole,
};

struct Console(Mutex<Option<isize>>);
impl Drop for Console {
    fn drop(&mut self) {
        if let Some(console) = self
            .0
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            unsafe { ClosePseudoConsole(console) };
        }
    }
}

/// Keeps terminal identity stable across input, output, and resize calls.
#[derive(Clone)]
pub struct Control(Arc<Console>);
impl Control {
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = size(cols, rows)?;
        let console = self
            .0
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let console = console.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "The Windows terminal has closed.",
            )
        })?;
        let result = unsafe { ResizePseudoConsole(console, size) };
        hresult(result)
    }

    pub(super) fn with_handle<T>(
        &self,
        use_handle: impl FnOnce(isize) -> io::Result<T>,
    ) -> io::Result<T> {
        let console = self
            .0
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let console = console.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "The Windows terminal has closed.",
            )
        })?;
        use_handle(console)
    }

    /// Call while the output reader is still draining. Closing ConPTY can emit
    /// a final terminal frame and must not run on a Tokio executor thread.
    pub async fn close(&self) -> io::Result<()> {
        let owner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let console = owner
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(console) = console {
                unsafe { ClosePseudoConsole(console) };
            }
        })
        .await
        .map_err(io::Error::other)
    }
}

pub fn create_terminal(cols: u16, rows: u16) -> io::Result<(AsyncFile, AsyncFile, Control)> {
    let size = size(cols, rows)?;
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let mut console = 0;
    hresult(unsafe {
        CreatePseudoConsole(size, raw(&input_read), raw(&output_write), 0, &mut console)
    })?;
    let control = Control(Arc::new(Console(Mutex::new(Some(console)))));
    Ok((
        AsyncFile::from_std(File::from(output_read)),
        AsyncFile::from_std(File::from(input_write)),
        control,
    ))
}

fn size(cols: u16, rows: u16) -> io::Result<COORD> {
    if cols == 0 || rows == 0 || cols > i16::MAX as u16 || rows > i16::MAX as u16 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows terminal dimensions must be between 1 and 32,767.",
        ));
    }
    Ok(COORD {
        X: cols as i16,
        Y: rows as i16,
    })
}
fn hresult(result: i32) -> io::Result<()> {
    if result < 0 {
        return Err(io::Error::from_raw_os_error(result & 0xffff));
    }
    Ok(())
}
