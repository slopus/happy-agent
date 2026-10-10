//! Stdio worker shell for the pinned upstream Monty 0.0.21 Rust state machine.
//! Adapted from pydantic/monty crates/monty-runtime/src/subprocess.rs (MIT).
use monty_proto::{
    FrameError, FrameReader, pb,
    worker::{Child, EventSink, HandleOutcome, fatal_error_event, protocol_violation},
    write_frame,
};
use std::{io, panic, process::ExitCode};

pub fn run() -> ExitCode {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = write_frame(
            &mut io::stdout(),
            &fatal_error_event(&format!("child panicked: {info}")),
        );
        default_hook(info);
    }));
    let mut reader = FrameReader::new(io::stdin().lock());
    let mut child = Child::default();
    let mut sink = StdoutSink;
    loop {
        match reader.read::<pb::ParentRequest>() {
            Ok(Some(request)) => {
                let outcome = child.handle(request, &mut sink);
                let budget = child.session_budget();
                if let Err(reason) = monty_alloc::set_limit(budget.max_memory, budget.type_check) {
                    fatal(&child, &mut sink, reason);
                    return ExitCode::from(4);
                }
                match outcome {
                    Ok(HandleOutcome::Continue) => {}
                    Ok(HandleOutcome::Shutdown) => return ExitCode::SUCCESS,
                    Ok(HandleOutcome::Fatal) => return ExitCode::from(4),
                    Err(FrameError::FrameTooLarge { len, max }) => {
                        fatal(
                            &child,
                            &mut sink,
                            &format!(
                                "response frame of {len} bytes exceeds maximum of {max} bytes"
                            ),
                        );
                        return ExitCode::from(76);
                    }
                    Err(_) => return ExitCode::from(3),
                }
            }
            Ok(None) => return ExitCode::SUCCESS,
            Err(FrameError::Decode(error)) => {
                if sink
                    .send(&protocol_violation(&format!("malformed request: {error}")))
                    .is_err()
                {
                    return ExitCode::from(3);
                }
            }
            Err(error) => {
                fatal(
                    &child,
                    &mut sink,
                    &format!("malformed request frame: {error}"),
                );
                return ExitCode::from(76);
            }
        }
    }
}
struct StdoutSink;
impl EventSink for StdoutSink {
    fn send(&mut self, event: &pb::ChildEvent) -> Result<(), FrameError> {
        write_frame(&mut io::stdout(), event)
    }
}
fn fatal(child: &Child, sink: &mut impl EventSink, message: &str) {
    eprintln!("Workflow worker fatal error: {message}");
    let _ = sink.send(&child.fatal_event(message));
}
