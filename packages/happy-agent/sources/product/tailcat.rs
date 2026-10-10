mod connection;
mod exposure;
pub use connection::{CarrierSocket, TailcatConnection};
pub use exposure::TailcatExposure;
#[cfg(test)]
mod tests;

mod owner;
pub use owner::TailcatModule;
