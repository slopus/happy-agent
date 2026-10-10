use super::*;
use std::cmp::Ordering;
struct Budget {
    entries: usize,
    files: usize,
}
impl Budget {
    fn full(&self, skills: usize) -> bool {
        self.entries >= 4096 || self.files >= 256 || skills >= MAX_SKILLS
    }
}
impl SkillsModule {
    async fn roots(
        &self,
        compute: &ComputeFilesystem,
        configured: &[PathBuf],
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        let ancestors = compute
            .cwd()
            .ancestors()
            .map(Path::to_owned)
            .collect::<Vec<_>>();
        let mut project_root_index = 0;
        for (index, directory) in ancestors.iter().enumerate() {
            if compute
                .exists(&directory.join(".git"), cancel)
                .await
                .unwrap_or(false)
            {
                project_root_index = index;
                break;
            }
        }
        let home = compute.home();
        let mut roots = Vec::new();
        for directory in &ancestors[..=project_root_index] {
            if home.as_ref() == Some(directory) {
                continue;
            }
            let root = json!({"path":directory.join(".agents/skills"),"source":"project"});
            if self.schemas.valid("ownerDiscoveredSkillRoot", &root)? {
                roots.push(root);
            }
        }
        let project = &ancestors[project_root_index];
        if let Ok(bytes) = compute
            .read_file(&project.join("happy.toml"), 1_048_576, true, cancel)
            .await
        {
            if bytes.len() <= 1_048_576 {
                if let Ok(directories) = self.config.project_skill_directories(&decode(&bytes)) {
                    for directory in directories {
                        let root = json!({"path":project.join(directory),"source":"project"});
                        if self.schemas.valid("ownerDiscoveredSkillRoot", &root)? {
                            roots.push(root);
                        }
                    }
                }
            }
        }
        if let Some(home) = home {
            let root = json!({"path":home.join(".agents/skills"),"source":"user"});
            if self.schemas.valid("ownerDiscoveredSkillRoot", &root)? {
                roots.push(root);
            }
        }
        for directory in configured {
            let root = json!({"path":directory,"source":"user"});
            if self.schemas.valid("ownerDiscoveredSkillRoot", &root)? {
                roots.push(root);
            }
        }
        Ok(roots)
    }
    pub(super) async fn discover(
        &self,
        compute: &ComputeFilesystem,
        unavailable: &BTreeSet<PathBuf>,
        configured: &[PathBuf],
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        let mut skills = Vec::new();
        let mut budget = Budget {
            entries: 0,
            files: 0,
        };
        for root in self.roots(compute, configured, cancel).await? {
            anyhow::ensure!(
                !cancel.is_cancelled(),
                "The skill discovery was interrupted."
            );
            if skills.len() >= MAX_SKILLS || budget.entries >= 4096 {
                break;
            }
            self.scan_root(
                compute,
                &root,
                &mut skills,
                &mut budget,
                unavailable,
                cancel,
            )
            .await?;
        }
        skills.sort_by(|left, right| {
            compare_names(
                left["name"].as_str().unwrap(),
                right["name"].as_str().unwrap(),
            )
        });
        Ok(skills)
    }
    async fn scan_root(
        &self,
        compute: &ComputeFilesystem,
        root: &Value,
        skills: &mut Vec<Value>,
        budget: &mut Budget,
        unavailable: &BTreeSet<PathBuf>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let path = Path::new(root["path"].as_str().unwrap());
        let Ok(stat) = compute.stat(path, true, cancel).await else {
            return Ok(());
        };
        if stat.is_null() {
            return Ok(());
        }
        let Ok(canonical) = compute.canonical_path(path, cancel).await else {
            return Ok(());
        };
        let mut visited = BTreeSet::from([canonical.clone()]);
        let mut directories = vec![(canonical, stat["isSymbolicLink"] != true)];
        let mut index = 0;
        while index < directories.len() && !budget.full(skills.len()) {
            anyhow::ensure!(
                !cancel.is_cancelled(),
                "The skill discovery was interrupted."
            );
            let (directory, container) = directories[index].clone();
            index += 1;
            let mut after: Option<String> = None;
            loop {
                let Ok(page) = compute
                    .entries(
                        &directory,
                        after.as_deref(),
                        (4096 - budget.entries).min(256),
                        cancel,
                    )
                    .await
                else {
                    break;
                };
                if !self
                    .schemas
                    .valid("ownerDiscoveredSkillDirectoryPage", &page)?
                {
                    break;
                }
                let entries = page["entries"].as_array().unwrap();
                let names = entries
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| {
                        !name.starts_with('.') && *name != "node_modules" && plain_name(name)
                    })
                    .take(4096 - budget.entries)
                    .collect::<Vec<_>>();
                let paths = names
                    .iter()
                    .map(|name| directory.join(name))
                    .collect::<Vec<_>>();
                let stats = compute.lstat_many(&paths, cancel).await.ok();
                for (item, name) in names.iter().enumerate() {
                    budget.entries += 1;
                    let path = &paths[item];
                    let stat = match &stats {
                        Some(stats) => stats.get(item).cloned(),
                        None => compute.stat(path, true, cancel).await.ok(),
                    };
                    let Some(stat) = stat.filter(|stat| !stat.is_null()) else {
                        continue;
                    };
                    if stat["isSymbolicLink"] == true {
                        if let Ok(followed) = compute.stat(path, false, cancel).await {
                            if followed["isDirectory"] == true {
                                if let Ok(canonical) = compute.canonical_path(path, cancel).await {
                                    if visited.insert(canonical.clone()) {
                                        directories.push((canonical, false));
                                    }
                                }
                            }
                        }
                    } else if stat["isDirectory"] == true {
                        if visited.insert(path.clone()) {
                            directories.push((path.clone(), false));
                        }
                    } else if stat["isFile"] == true && *name == "SKILL.md" && !container {
                        if root["source"] == "user" && unavailable.contains(path) {
                            continue;
                        }
                        budget.files += 1;
                        if budget.files > 256 {
                            return Ok(());
                        }
                        if let Ok(entry) = self
                            .read_entry(compute, path, root["source"].as_str().unwrap(), cancel)
                            .await
                        {
                            if let Some(existing) = skills
                                .iter_mut()
                                .find(|existing| existing["name"] == entry["name"])
                            {
                                if source_priority(&entry) > source_priority(existing) {
                                    *existing = entry;
                                }
                            } else {
                                skills.push(entry);
                            }
                        }
                    }
                    if budget.entries >= 4096 || skills.len() >= MAX_SKILLS {
                        return Ok(());
                    }
                }
                if entries.is_empty() || page["hasMore"] != true || budget.full(skills.len()) {
                    break;
                }
                after = entries.last().and_then(Value::as_str).map(str::to_owned);
            }
        }
        Ok(())
    }
    async fn read_entry(
        &self,
        compute: &ComputeFilesystem,
        path: &Path,
        source: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let bytes = compute
            .read_file(path, DOCUMENT_BYTES, true, cancel)
            .await?;
        anyhow::ensure!(
            bytes.len() <= DOCUMENT_BYTES,
            "The skill document exceeds its size limit."
        );
        let directory = path
            .parent()
            .and_then(Path::file_name)
            .context("The skill directory is invalid.")?
            .to_string_lossy();
        let mut metadata = self.global.parse_metadata(&decode(&bytes), &directory)?;
        metadata["location"] = json!(path);
        metadata["source"] = json!(source);
        anyhow::ensure!(
            self.schemas.valid("ownerDiscoveredSkill", &metadata)?,
            "The skill metadata is invalid."
        );
        Ok(metadata)
    }
}
fn plain_name(name: &str) -> bool {
    !name.is_empty() && !matches!(name, "." | "..") && !name.contains(['/', '\\', '\0'])
}
fn source_priority(entry: &Value) -> u8 {
    if matches!(entry["source"].as_str(), Some("project" | "user")) {
        2
    } else {
        0
    }
}
// Skill names are ASCII by their original TypeBox schema. English collation
// places punctuation before numbers and letters, and lower case before upper.
fn compare_names(left: &str, right: &str) -> Ordering {
    fn weight(value: u8) -> u8 {
        match value {
            b'_' => 1,
            b'-' => 2,
            b'.' => 3,
            b'0'..=b'9' => value - b'0' + 4,
            _ => value.to_ascii_lowercase() - b'a' + 14,
        }
    }
    left.bytes()
        .map(weight)
        .cmp(right.bytes().map(weight))
        .then_with(|| {
            left.bytes()
                .map(|value| value.is_ascii_uppercase())
                .cmp(right.bytes().map(|value| value.is_ascii_uppercase()))
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ascii_skill_name_collation_matches_original_source_discovery() {
        let golden: Value = serde_json::from_str(include_str!("source_goldens.json")).unwrap();
        let mut names = golden["sortNames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect::<Vec<_>>();
        names.sort_by(|left, right| compare_names(left, right));
        assert_eq!(json!(names), golden["sortedNames"]);
    }
}
