mod credentials;
mod error;
pub mod protocol;
mod session;
mod types;

pub use credentials::{Credential, CredentialSource, CredentialUnavailable};
pub use error::{ErrorKind, ProviderError};
pub use session::{BedrockTransport, HttpSession, ProviderConfig, ProviderKind, Transport};
pub use types::*;
mod account_probe;
pub use account_probe::probe_account_authentication;
