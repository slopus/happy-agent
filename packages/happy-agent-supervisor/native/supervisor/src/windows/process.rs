use super::{
    Command, Control, Job, arguments,
    attributes::Attributes,
    handles::{own, raw},
    pipes::{self, Stream},
};
use std::{
    io,
    os::windows::{io::OwnedHandle, process::ExitStatusExt},
    process::ExitStatus,
    sync::Arc,
    time::Duration,
};
use windows_sys::Win32::Foundation::{
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    WaitForSingleObject,
};

/// The process and its tree are kernel identities, never reopenable numeric PIDs.
pub struct Child {
    process: OwnedHandle,
    pid: u32,
    job: Arc<Job>,
    terminal: Option<Control>,
    status: Option<ExitStatus>,
    pub stdin: Option<Stream>,
    pub stdout: Option<Stream>,
    pub stderr: Option<Stream>,
}

impl Child {
    pub fn id(&self) -> Option<u32> {
        Some(self.pid)
    }
    pub fn job(&self) -> Arc<Job> {
        self.job.clone()
    }
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        loop {
            match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
                WAIT_OBJECT_0 => break,
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(10)).await,
                WAIT_FAILED => return Err(io::Error::last_os_error()),
                _ => {
                    return Err(io::Error::other(
                        "Windows returned an unexpected process wait result.",
                    ));
                }
            }
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let status = ExitStatus::from_raw(code);
        self.status = Some(status);
        if self.job.active_processes()? == 0
            && let Some(terminal) = &self.terminal
        {
            terminal.close().await?;
        }
        Ok(status)
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.status.is_none() {
            let _ = self.job.terminate();
        }
    }
}

/// Spawn with explicit pipes or a previously prepared ConPTY. Standard streams
/// are the only inherited handles, and the Job is attached at process creation.
pub(super) fn spawn(command: &Command, terminal: Option<&Control>) -> io::Result<Child> {
    let job = Arc::new(Job::create()?);
    let mut line = arguments::command_line(command)?;
    let environment = arguments::environment(command)?;
    let cwd = command
        .inner
        .get_current_dir()
        .map(|path| arguments::wide(path.as_os_str()))
        .transpose()?;
    let mut info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    let mut attributes = Attributes::new(2)?;
    attributes.job(job.raw())?;
    let mut flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    let mut stdio = None;
    if terminal.is_none() {
        let (input_write, input_read) = pipes::create(true)?;
        let (output_read, output_write) = pipes::create(false)?;
        let (error_read, error_write) = pipes::create(false)?;
        let handles = [raw(&input_read), raw(&output_write), raw(&error_write)];
        for handle in handles {
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        attributes.handles(handles.to_vec())?;
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = handles[0];
        info.StartupInfo.hStdOutput = handles[1];
        info.StartupInfo.hStdError = handles[2];
        flags |= CREATE_NO_WINDOW;
        stdio = Some((
            input_read,
            input_write,
            output_read,
            output_write,
            error_read,
            error_write,
        ));
    } else {
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        info.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        info.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    }
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut create = |console: Option<isize>| {
        if let Some(console) = console {
            attributes.terminal(console)?;
        }
        info.lpAttributeList = attributes.raw();
        if unsafe {
            CreateProcessW(
                std::ptr::null(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                i32::from(terminal.is_none()),
                flags,
                environment.as_ptr().cast(),
                cwd.as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                &info.StartupInfo,
                &mut process,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    };
    if let Some(terminal) = terminal {
        terminal.with_handle(|console| create(Some(console)))?;
    } else {
        create(None)?;
    }
    let handle = unsafe { own(process.hProcess)? };
    let _thread = unsafe { own(process.hThread)? };
    let (stdin, stdout, stderr) = if let Some((
        input_read,
        input_write,
        output_read,
        output_write,
        error_read,
        error_write,
    )) = stdio
    {
        drop((input_read, output_write, error_write));
        (Some(input_write), Some(output_read), Some(error_read))
    } else {
        (None, None, None)
    };
    Ok(Child {
        process: handle,
        pid: process.dwProcessId,
        job,
        terminal: terminal.cloned(),
        status: None,
        stdin,
        stdout,
        stderr,
    })
}
