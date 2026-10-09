use crate::product::{
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

const MAX_ROWS: u64 = 20_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-auto-evidence",
        "CREATE TABLE happy_agent_auto_evidence(agent_id TEXT NOT NULL,generation INTEGER NOT NULL,position INTEGER NOT NULL,category TEXT NOT NULL,entry_json TEXT NOT NULL,trusted_user_evidence INTEGER NOT NULL,trusted_user_evidence_truncated INTEGER NOT NULL,PRIMARY KEY(agent_id,generation,position));CREATE TABLE happy_agent_auto_state(agent_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,next_position INTEGER NOT NULL,archive_healthy INTEGER NOT NULL);CREATE TABLE happy_agent_auto_user_evidence(agent_id TEXT NOT NULL,call_id TEXT NOT NULL,content_json TEXT NOT NULL,PRIMARY KEY(agent_id,call_id));",
    ),
    (
        "002-native-complete-generation",
        "CREATE TABLE happy_agent_auto_native_generations(agent_id TEXT PRIMARY KEY,generation INTEGER NOT NULL);",
    ),
];

pub(super) struct EvidenceStore {
    runtime: Arc<RuntimeModule>,
    schemas: Schemas,
    poisoned: Mutex<Poison>,
}
enum Poison {
    Agents(BTreeSet<String>),
    All,
}
impl EvidenceStore {
    pub fn new(runtime: Arc<RuntimeModule>) -> Result<Self> {
        Ok(Self {
            runtime,
            schemas: Schemas::new()?,
            poisoned: Mutex::new(Poison::Agents(BTreeSet::new())),
        })
    }
    pub async fn load(&self) -> Result<()> {
        self.runtime.migrate("auto", MIGRATIONS).await
    }
    fn validate(&self, name: &str, value: &Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid(name, value)?,
            "The automatic permission review evidence archive is invalid."
        );
        Ok(())
    }
    pub fn state(&self, ctx: &Context<'_>, agent: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let row: Option<String> = ctx.database().query_row("SELECT json_object('generation',generation,'next_position',next_position,'archive_healthy',archive_healthy) FROM happy_agent_auto_state WHERE agent_id=?1", [agent], |row| row.get(0)).optional()?;
        let poisoned = match &*self
            .poisoned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            Poison::All => true,
            Poison::Agents(agents) => agents.contains(agent),
        };
        let state = if let Some(row) = row {
            let row: Value = serde_json::from_str(&row)?;
            self.validate("autoStoredState", &row)?;
            let generation = integer(&row["generation"])?;
            // The original context-erasure hook discarded the earlier archive.
            // Only a native identity recreation can prove a later generation
            // began with complete new authorization history.
            let native: Option<String> = ctx.database().query_row("SELECT json_quote(generation) FROM happy_agent_auto_native_generations WHERE agent_id=?1", [agent], |row| row.get(0)).optional()?;
            let native_generation = native
                .map(|encoded| -> Result<u64> {
                    let raw: Value = serde_json::from_str(&encoded)?;
                    self.validate("autoStoredInteger", &raw)?;
                    integer(&raw)
                })
                .transpose()?;
            json!({"generation":generation,"nextPosition":integer(&row["next_position"])? ,"archiveHealthy":flag(&row["archive_healthy"])? && !poisoned && (generation == 0 || native_generation == Some(generation))})
        } else {
            let has_evidence: bool = ctx.database().query_row(
                "SELECT EXISTS(SELECT 1 FROM happy_agent_auto_evidence WHERE agent_id=?1) OR EXISTS(SELECT 1 FROM happy_agent_records WHERE owner_id=?1) OR EXISTS(SELECT 1 FROM happy_agent_values WHERE owner_id='' AND key='agentSystem.config.'||?1)",
                [agent],
                |row| row.get(0),
            )?;
            json!({"generation":0,"nextPosition":0,"archiveHealthy":!has_evidence && !poisoned})
        };
        self.validate("autoEvidenceState", &state)?;
        Ok(state)
    }
    fn write_state(&self, ctx: &Context<'_>, agent: &str, state: &Value) -> Result<()> {
        self.validate("autoEvidenceState", state)?;
        ctx.database().execute("INSERT INTO happy_agent_auto_state(agent_id,generation,next_position,archive_healthy) VALUES(?1,?2,?3,?4) ON CONFLICT(agent_id) DO UPDATE SET generation=excluded.generation,next_position=excluded.next_position,archive_healthy=excluded.archive_healthy", params![agent,state["generation"].as_u64(),state["nextPosition"].as_u64(),state["archiveHealthy"].as_bool()])?;
        Ok(())
    }
    pub fn append(&self, ctx: &Context<'_>, agent: &str, evidence: &Value) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        self.validate("autoEvidenceEntry", evidence)?;
        self.validate_classification(evidence)?;
        let mut state = self.state(ctx, agent)?;
        let position = state["nextPosition"]
            .as_u64()
            .context("The automatic permission evidence cursor is invalid.")?;
        anyhow::ensure!(
            position < MAX_ROWS,
            "The automatic permission review evidence exceeds the review budget."
        );
        let encoded = evidence["entry"].to_string();
        let bytes: u64 = ctx.database().query_row("SELECT coalesce(sum(length(CAST(entry_json AS BLOB))),0) FROM happy_agent_auto_evidence WHERE agent_id=?1", [agent], |row| row.get(0))?;
        anyhow::ensure!(
            encoded.len() <= MAX_BYTES && bytes <= (MAX_BYTES - encoded.len()) as u64,
            "The automatic permission review evidence exceeds the review budget."
        );
        ctx.database().execute("INSERT INTO happy_agent_auto_evidence(agent_id,generation,position,category,entry_json,trusted_user_evidence,trusted_user_evidence_truncated) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![agent,state["generation"].as_u64(),position,evidence["category"].as_str(),encoded,evidence["trustedUserEvidence"].as_bool(),evidence["trustedUserEvidenceTruncated"].as_bool()])?;
        state["nextPosition"] = json!(position + 1);
        self.write_state(ctx, agent, &state)
    }
    pub fn entries(&self, ctx: &Context<'_>, agent: &str) -> Result<(Value, Vec<Value>)> {
        let state = self.state(ctx, agent)?;
        anyhow::ensure!(
            state["archiveHealthy"] == true,
            "The automatic permission review evidence archive is incomplete."
        );
        let generation = state["generation"]
            .as_u64()
            .context("The automatic permission evidence generation is invalid.")?;
        let mut statement = ctx.database().prepare("SELECT json_object('position',position,'category',category,'entry_json',entry_json,'trusted_user_evidence',trusted_user_evidence,'trusted_user_evidence_truncated',trusted_user_evidence_truncated) FROM happy_agent_auto_evidence WHERE agent_id=?1 AND generation=?2 ORDER BY position LIMIT 20001")?;
        let mut entries = Vec::new();
        let mut bytes = 0;
        for row in statement.query_map(params![agent, generation], |row| row.get::<_, String>(0))? {
            let encoded = row?;
            bytes += encoded.len();
            anyhow::ensure!(
                bytes <= MAX_BYTES && entries.len() < MAX_ROWS as usize,
                "The automatic permission review evidence exceeds the review budget."
            );
            let row: Value = serde_json::from_str(&encoded)?;
            self.validate("autoStoredEntry", &row)?;
            anyhow::ensure!(
                integer(&row["position"])? == entries.len() as u64,
                "The automatic permission review evidence archive is invalid."
            );
            let entry: Value = serde_json::from_str(
                row["entry_json"]
                    .as_str()
                    .context("The stored automatic permission evidence is invalid.")?,
            )?;
            let evidence = json!({"category":row["category"],"entry":entry,"trustedUserEvidence":flag(&row["trusted_user_evidence"])? ,"trustedUserEvidenceTruncated":flag(&row["trusted_user_evidence_truncated"])?});
            self.validate("autoEvidenceEntry", &evidence)?;
            self.validate_classification(&evidence)?;
            entries.push(evidence);
        }
        anyhow::ensure!(
            state["nextPosition"].as_u64() == Some(entries.len() as u64),
            "The automatic permission review evidence archive is invalid."
        );
        Ok((state, entries))
    }
    fn validate_classification(&self, evidence: &Value) -> Result<()> {
        let (category, trusted) = super::entries::classification(&evidence["entry"])?;
        anyhow::ensure!(
            evidence["category"] == category
                && evidence["trustedUserEvidence"] == trusted
                && (evidence["trustedUserEvidenceTruncated"] != true || trusted),
            "The automatic permission review evidence classification is invalid."
        );
        Ok(())
    }
    pub fn review_transcript(&self, ctx: &Context<'_>, agent: &str) -> Result<(Value, Value)> {
        let (state, entries) = self.entries(ctx, agent)?;
        let messages: Vec<Value> = entries.iter().map(|entry| entry["entry"].clone()).collect();
        let mut transcript = super::transcript::create(&messages)?;
        // The pure original builder cannot see the archive's prior truncation
        // flag, or trusted rows it skips as generated/internal content. Neither
        // absence can become permission to act from incomplete evidence.
        let lost = entries.iter().any(|entry| {
            entry["trustedUserEvidence"] == true
                && (entry["trustedUserEvidenceTruncated"] == true
                    || !super::transcript::retains_trusted_entry(&entry["entry"]))
        });
        if lost && transcript["userEvidenceOmitted"] != true {
            transcript["userEvidenceOmitted"] = json!(true);
            let text = transcript["text"].as_str().unwrap();
            transcript["text"] = json!(format!(
                "{text}{}{}",
                if text.is_empty() { "" } else { "\n\n" },
                super::transcript::EVIDENCE_OMITTED
            ));
        }
        Ok((state, transcript))
    }
    pub fn poison(&self, ctx: &Context<'_>, agent: &str) {
        let mut poisoned = self
            .poisoned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The catalog's 10,000-agent bound also bounds the poison map. If that
        // invariant is exceeded, every review remains unproven in this process.
        if let Poison::Agents(agents) = &mut *poisoned {
            if agents.len() < 10000 {
                agents.insert(agent.to_owned());
            } else {
                *poisoned = Poison::All;
            }
        }
        drop(poisoned);
        if let Ok(mut state) = self.state(ctx, agent) {
            state["archiveHealthy"] = json!(false);
            let _ = self.write_state(ctx, agent, &state);
        }
    }
    /// A genuinely recreated agent identity begins new authorization history.
    /// Compaction and model changes deliberately never call this operation.
    pub fn recreate(self: &Arc<Self>, ctx: &Context<'_>, agent: &str) -> Result<()> {
        let state = self.state(ctx, agent)?;
        let generation = state["generation"]
            .as_u64()
            .context("The automatic permission evidence generation is invalid.")?
            .checked_add(1)
            .context("The automatic permission evidence generation is exhausted.")?;
        ctx.database().execute(
            "DELETE FROM happy_agent_auto_evidence WHERE agent_id=?1",
            [agent],
        )?;
        ctx.database().execute(
            "DELETE FROM happy_agent_auto_user_evidence WHERE agent_id=?1",
            [agent],
        )?;
        self.write_state(
            ctx,
            agent,
            &json!({"generation":generation,"nextPosition":0,"archiveHealthy":true}),
        )?;
        ctx.database().execute("INSERT INTO happy_agent_auto_native_generations(agent_id,generation) VALUES(?1,?2) ON CONFLICT(agent_id) DO UPDATE SET generation=excluded.generation", params![agent,generation])?;
        let store = self.clone();
        let agent = agent.to_owned();
        ctx.after_commit(move || {
            if let Poison::Agents(agents) = &mut *store
                .poisoned
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
            {
                agents.remove(&agent);
            }
        })
    }
    pub fn answer(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        call: &str,
        content: &Value,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        self.validate("autoTranscriptMessage", content)?;
        let encoded = content.to_string();
        let (count, bytes, previous): (u64,u64,u64) = ctx.database().query_row("SELECT count(*),coalesce(sum(length(CAST(content_json AS BLOB))),0),coalesce(sum(CASE WHEN call_id=?2 THEN length(CAST(content_json AS BLOB)) ELSE 0 END),0) FROM happy_agent_auto_user_evidence WHERE agent_id=?1", params![agent,call], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        anyhow::ensure!(
            encoded.len() <= MAX_BYTES
                && (count < MAX_ROWS || previous > 0)
                && bytes.saturating_sub(previous) <= (MAX_BYTES - encoded.len()) as u64,
            "The automatic permission review answer exceeds its storage budget."
        );
        ctx.database().execute("INSERT INTO happy_agent_auto_user_evidence(agent_id,call_id,content_json) VALUES(?1,?2,?3) ON CONFLICT(agent_id,call_id) DO UPDATE SET content_json=excluded.content_json", params![agent,call,encoded])?;
        Ok(())
    }
    pub fn consume_answer(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        call: &str,
    ) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let encoded: Option<String> = ctx.database().query_row("SELECT content_json FROM happy_agent_auto_user_evidence WHERE agent_id=?1 AND call_id=?2", params![agent,call], |row| row.get(0)).optional()?;
        let Some(encoded) = encoded else {
            return Ok(None);
        };
        anyhow::ensure!(
            encoded.len() <= MAX_BYTES,
            "The stored automatic permission answer exceeds its byte budget."
        );
        let content: Value = serde_json::from_str(&encoded)?;
        self.validate("autoTranscriptMessage", &content)?;
        ctx.database().execute(
            "DELETE FROM happy_agent_auto_user_evidence WHERE agent_id=?1 AND call_id=?2",
            params![agent, call],
        )?;
        Ok(Some(content))
    }
}
fn integer(value: &Value) -> Result<u64> {
    if let Some(value) = value.as_u64() {
        Ok(value)
    } else {
        value
            .as_str()
            .context("The stored automatic permission integer is invalid.")?
            .parse()
            .map_err(Into::into)
    }
}
fn flag(value: &Value) -> Result<bool> {
    if let Some(value) = value.as_u64() {
        Ok(value == 1)
    } else {
        Ok(value
            .as_str()
            .context("The stored automatic permission flag is invalid.")?
            == "1")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::config::ConfigModule;

    struct Fixture {
        _directory: tempfile::TempDir,
        runtime: Arc<RuntimeModule>,
        store: Arc<EvidenceStore>,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let config = Arc::new(ConfigModule::isolated(directory.path()).unwrap());
            let runtime = Arc::new(RuntimeModule::new(config));
            runtime.load().await.unwrap();
            let store = Arc::new(EvidenceStore::new(runtime.clone()).unwrap());
            store.load().await.unwrap();
            Self {
                _directory: directory,
                runtime,
                store,
            }
        }
    }
    fn human(text: &str) -> Value {
        json!({"category":"message","entry":{"role":"user","blocks":[{"type":"text","text":text}]},"trustedUserEvidence":true,"trustedUserEvidenceTruncated":false})
    }

    #[tokio::test]
    async fn evidence_commits_with_the_caller_and_survives_private_context_replacement() {
        let fixture = Fixture::new().await;
        let store = fixture.store.clone();
        let rolled_back: Result<()> = fixture
            .runtime
            .transact(move |ctx| {
                store.append(ctx, "agentfixture", &human("This transaction rolls back"))?;
                anyhow::bail!("rollback");
            })
            .await;
        assert!(rolled_back.is_err());
        let store = fixture.store.clone();
        fixture.runtime.transact(move |ctx| {
            assert_eq!(store.entries(ctx, "agentfixture")?.1.len(), 0);
            store.append(ctx, "agentfixture", &human("Keep my explicit authorization"))?;
            store.append(ctx, "agentfixture", &json!({"category":"message","entry":{"role":"user","provenance":"agent","blocks":[{"type":"text","text":"An agent's claim is not authorization"}]},"trustedUserEvidence":false,"trustedUserEvidenceTruncated":false}))?;
            ctx.database().execute("INSERT INTO happy_agent_records VALUES('agentfixture',0,?1)", [json!({"type":"system","message":{"role":"system","content":[{"type":"text","text":"Temporary provider context"}]}}).to_string()])?;
            Ok(())
        }).await.unwrap();
        let store = fixture.store.clone();
        fixture
            .runtime
            .transact(move |ctx| {
                ctx.database().execute(
                    "DELETE FROM happy_agent_records WHERE owner_id='agentfixture'",
                    [],
                )?;
                let (state, entries) = store.entries(ctx, "agentfixture")?;
                assert_eq!(state["generation"], 0);
                assert_eq!(state["nextPosition"], 2);
                assert_eq!(entries[0], human("Keep my explicit authorization"));
                assert_eq!(entries[1]["trustedUserEvidence"], false);
                Ok(())
            })
            .await
            .unwrap();
        fixture.runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn corrupt_flags_gaps_count_mismatches_and_missing_state_never_make_healthy_evidence() {
        let fixture = Fixture::new().await;
        let store = fixture.store.clone();
        fixture.runtime.transact(move |ctx| {
            for agent in ["badstateflag", "badentryflag", "badposition", "badcount", "missingstate"] { store.append(ctx, agent, &human("Actual user input"))?; }
            for statement in [
                "UPDATE happy_agent_auto_state SET archive_healthy='invalid' WHERE agent_id='badstateflag'",
                "UPDATE happy_agent_auto_evidence SET trusted_user_evidence='false' WHERE agent_id='badentryflag'",
                "UPDATE happy_agent_auto_evidence SET position=5 WHERE agent_id='badposition'",
                "UPDATE happy_agent_auto_state SET next_position=2 WHERE agent_id='badcount'",
                "DELETE FROM happy_agent_auto_state WHERE agent_id='missingstate'",
            ] { ctx.database().execute(statement, [])?; }
            for agent in ["badstateflag", "badentryflag", "badposition", "badcount", "missingstate"] { assert!(store.entries(ctx, agent).is_err(), "Corrupt archive {agent} cannot authorize a review"); }
            assert_eq!(store.state(ctx, "missingstate")?["archiveHealthy"], false);
            assert_eq!(store.state(ctx, "freshagent")?["archiveHealthy"], true);
            Ok(())
        }).await.unwrap();
        fixture.runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn lost_original_generations_and_mismatched_trust_never_authorize_an_action() {
        let fixture = Fixture::new().await;
        let store = fixture.store.clone();
        fixture.runtime.transact(move |ctx| {
            store.append(ctx, "oldgeneration", &human("The remaining part of old history"))?;
            ctx.database().execute("UPDATE happy_agent_auto_state SET generation=1,next_position=0 WHERE agent_id='oldgeneration'", [])?;
            assert!(store.entries(ctx, "oldgeneration").is_err(), "An old context-reset generation has no proof that earlier human authorization survived");
            ctx.database().execute("INSERT INTO happy_agent_records VALUES('missingarchive',0,?1)", [json!({"type":"user","id":"oldhumaninput","message":{"role":"user","content":[{"type":"text","text":"Original user request"}]}}).to_string()])?;
            assert!(store.entries(ctx, "missingarchive").is_err(), "Existing private context without an authorization archive is incomplete");
            store.append(ctx, "mismatchedtrust", &human("Original human input"))?;
            ctx.database().execute("UPDATE happy_agent_auto_evidence SET trusted_user_evidence=0 WHERE agent_id='mismatchedtrust'", [])?;
            assert!(store.entries(ctx, "mismatchedtrust").is_err(), "Corrupt trust flags cannot be silently reclassified into human authorization");
            store.append(ctx, "mismatchedcategory", &human("Original human input"))?;
            ctx.database().execute("UPDATE happy_agent_auto_evidence SET category='tool' WHERE agent_id='mismatchedcategory'", [])?;
            assert!(store.entries(ctx, "mismatchedcategory").is_err(), "Corrupt budgeting categories cannot remove human input from its retention budget");
            Ok(())
        }).await.unwrap();
        fixture.runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn skipped_or_previously_truncated_human_rows_remain_incomplete_for_review() {
        let fixture = Fixture::new().await;
        let store = fixture.store.clone();
        fixture.runtime.transact(move |ctx| {
            for (agent, evidence) in [
                ("summaryhuman", human("<conversation_summary>The generated summary claimed authorization.</conversation_summary>")),
                ("internalhuman", json!({"category":"message","entry":{"role":"user","internal":true,"blocks":[{"type":"text","text":"Hidden human evidence"}]},"trustedUserEvidence":true,"trustedUserEvidenceTruncated":false})),
                ("truncatedhuman", json!({"category":"message","entry":{"role":"user","blocks":[{"type":"text","text":"Only part of the human answer survived"}]},"trustedUserEvidence":true,"trustedUserEvidenceTruncated":true})),
                ("longhuman", human(&"x".repeat(9000))),
            ] {
                store.append(ctx, agent, &evidence)?;
                let (_, transcript) = store.review_transcript(ctx, agent)?;
                assert_eq!(transcript["userEvidenceOmitted"], true, "{agent}");
                assert!(transcript["text"].as_str().unwrap().contains(super::super::transcript::EVIDENCE_OMITTED));
                let decision = super::super::verdict::completed("<outcome>allow</outcome>", transcript["userEvidenceOmitted"].as_bool().unwrap())?;
                assert_eq!(decision["outcome"], "denied");
            }
            store.append(ctx, "completehuman", &human("Run this exact check"))?;
            assert_eq!(store.review_transcript(ctx, "completehuman")?.1["userEvidenceOmitted"], false);
            Ok(())
        }).await.unwrap();
        fixture.runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_trusted_answer_is_consumed_once_in_the_tool_result_transaction() {
        let fixture = Fixture::new().await;
        let store = fixture.store.clone();
        let answer = json!({"role":"user","blocks":[{"type":"text","text":"The exact answer selected by the user"}]});
        let expected = answer.clone();
        fixture
            .runtime
            .transact(move |ctx| store.answer(ctx, "agentfixture", "requestfixture", &answer))
            .await
            .unwrap();
        let store = fixture.store.clone();
        let rolled_back: Result<()> = fixture
            .runtime
            .transact(move |ctx| {
                assert!(
                    store
                        .consume_answer(ctx, "agentfixture", "requestfixture")?
                        .is_some()
                );
                anyhow::bail!("The owning tool result rolls back");
            })
            .await;
        assert!(rolled_back.is_err());
        let store = fixture.store.clone();
        fixture
            .runtime
            .transact(move |ctx| {
                assert_eq!(
                    store.consume_answer(ctx, "agentfixture", "requestfixture")?,
                    Some(expected)
                );
                assert_eq!(
                    store.consume_answer(ctx, "agentfixture", "requestfixture")?,
                    None
                );
                Ok(())
            })
            .await
            .unwrap();
        fixture.runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn failed_durable_poison_remains_unhealthy_until_identity_recreation_commits() {
        let fixture = Fixture::new().await;
        let store = fixture.store.clone();
        fixture.runtime.transact(move |ctx| {
            store.append(ctx, "agentfixture", &human("Original evidence"))?;
            store.append(ctx, "unrelatedagent", &human("Keep this independent archive"))?;
            ctx.database().execute_batch("CREATE TRIGGER poison_failure BEFORE UPDATE ON happy_agent_auto_state BEGIN SELECT RAISE(ABORT,'poison write unavailable'); END;")?;
            store.poison(ctx, "agentfixture");
            assert_eq!(store.state(ctx, "agentfixture")?["archiveHealthy"], false);
            let stored: i64 = ctx.database().query_row("SELECT archive_healthy FROM happy_agent_auto_state WHERE agent_id='agentfixture'", [], |row| row.get(0))?;
            assert_eq!(stored, 1, "The failing write did not overwrite the durable flag");
            ctx.database().execute_batch("DROP TRIGGER poison_failure;")?;
            Ok(())
        }).await.unwrap();
        let store = fixture.store.clone();
        let rolled_back: Result<()> = fixture
            .runtime
            .transact(move |ctx| {
                store.recreate(ctx, "agentfixture")?;
                anyhow::bail!("identity recreation rolls back");
            })
            .await;
        assert!(rolled_back.is_err());
        let store = fixture.store.clone();
        fixture
            .runtime
            .transact(move |ctx| {
                assert!(store.entries(ctx, "agentfixture").is_err());
                store.recreate(ctx, "agentfixture")?;
                assert!(
                    store.entries(ctx, "agentfixture").is_err(),
                    "The poison is cleared only after commit"
                );
                Ok(())
            })
            .await
            .unwrap();
        let store = fixture.store.clone();
        fixture
            .runtime
            .transact(move |ctx| {
                let (state, entries) = store.entries(ctx, "agentfixture")?;
                assert_eq!(state["generation"], 1);
                assert!(entries.is_empty());
                assert_eq!(
                    store.entries(ctx, "unrelatedagent")?.1[0],
                    human("Keep this independent archive")
                );
                Ok(())
            })
            .await
            .unwrap();
        fixture.runtime.close().await.unwrap();
    }
}
