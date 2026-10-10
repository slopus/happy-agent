use super::ConfigModule;
use std::path::Path;

impl ConfigModule {
    pub fn project_local_home(&self) -> &Path {
        &self.os_home
    }
}