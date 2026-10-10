//! User-authored skill folders and generated runtime folders keep separate ownership.
use super::*;
impl ConfigModule {
    pub fn resolve_skill_directory(&self,directory:&str)->PathBuf {let path=if directory=="~"{self.os_home.clone()}else if let Some(relative)=directory.strip_prefix("~/"){self.os_home.join(relative)}else{self.os_home.join(directory)};normalize_path(&path)}
    pub fn user_skill_directories(&self)->Vec<PathBuf>{self.skill_directories(&self.global_values)}
    pub fn runtime_skill_directories(&self)->Vec<PathBuf>{self.skill_directories(&self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner))}
    pub fn global_skill_directories(&self)->Vec<PathBuf>{let mut directories=self.user_skill_directories();for directory in self.runtime_skill_directories(){if !directories.contains(&directory){directories.push(directory);}}directories}
    fn skill_directories(&self,values:&toml::Value)->Vec<PathBuf>{values.get("skills").and_then(|values|values.get("directories")).and_then(toml::Value::as_array).into_iter().flatten().filter_map(toml::Value::as_str).map(|directory|self.resolve_skill_directory(directory)).collect()}
    pub async fn add_runtime_skill_directory(&self,directory:&str)->Result<bool>{self.change_runtime_skill_directory(directory,true).await}
    pub async fn remove_runtime_skill_directory(&self,directory:&str)->Result<bool>{self.change_runtime_skill_directory(directory,false).await}
    async fn change_runtime_skill_directory(&self,directory:&str,adding:bool)->Result<bool>{
        let resolved=self.resolve_skill_directory(directory);let _writer=self.runtime_writer.lock().await;let mut next=self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();let mut directories=self.skill_directories(&next);
        if directories.contains(&resolved)==adding{return Ok(false);}if adding{directories.push(resolved);}else{directories.retain(|directory|directory!=&resolved);}
        let table=next.as_table_mut().context("The runtime configuration is invalid.")?;
        if directories.is_empty(){table.remove("skills");}else{table.insert("skills".to_owned(),toml::Value::try_from(serde_json::json!({"directories":directories}))?);}
        validate_configuration(&next)?;let text=toml::to_string_pretty(&next)?;anyhow::ensure!(text.len()<=1_048_576,"The generated runtime configuration exceeds its size limit.");let path=self.paths.directory.join("runtime.toml");tokio::task::spawn_blocking(move||atomic_private(&path,text.as_bytes())).await??;*self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner)=next;Ok(true)
    }
}