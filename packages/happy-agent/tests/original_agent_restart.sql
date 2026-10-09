CREATE TABLE happy_agent_migrations(module_key TEXT NOT NULL,migration_key TEXT NOT NULL,position BIGINT NOT NULL,PRIMARY KEY(module_key,migration_key),UNIQUE(module_key,position));
CREATE TABLE happy_agent_records(owner_id TEXT NOT NULL,position BIGINT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(owner_id,position));
CREATE TABLE happy_agent_values(owner_id TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(owner_id,key));
CREATE TABLE happy_agent_loader_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO happy_agent_loader_state VALUES('installation_epoch','retained-original-installation'),('schema_version','1');
CREATE TABLE happy_agent_module_history(agent_id TEXT NOT NULL,position BIGINT NOT NULL,record_id TEXT NOT NULL,role TEXT NOT NULL,message_json TEXT NOT NULL,search_text TEXT NOT NULL,assistant_messages BIGINT NOT NULL,user_messages BIGINT NOT NULL,text_characters BIGINT NOT NULL,thinking_blocks BIGINT NOT NULL,tool_calls BIGINT NOT NULL,tool_results BIGINT NOT NULL,run_id TEXT,PRIMARY KEY(agent_id,position),UNIQUE(agent_id,record_id));
CREATE INDEX happy_agent_module_history_run_position ON happy_agent_module_history(agent_id,run_id,position);
CREATE TABLE happy_agent_module_history_runs(agent_id TEXT NOT NULL,sequence BIGINT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,started_at BIGINT NOT NULL,ended_at BIGINT,PRIMARY KEY(agent_id,sequence),UNIQUE(agent_id,run_id));
CREATE TABLE happy_agent_module_history_pending(agent_id TEXT NOT NULL,position BIGINT NOT NULL,message_id TEXT NOT NULL,message_json TEXT NOT NULL,PRIMARY KEY(agent_id,position),UNIQUE(agent_id,message_id));
CREATE TABLE happy_agent_module_history_tool_calls(agent_id TEXT NOT NULL,call_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(agent_id,call_id));
CREATE TABLE happy_agent_events(event_id TEXT PRIMARY KEY,agent_id TEXT,occurred_at INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,payload_bytes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX happy_agent_events_agent_id_event_id ON happy_agent_events(agent_id,event_id);
CREATE INDEX happy_agent_events_retention ON happy_agent_events(event_id DESC,payload_bytes);
CREATE TABLE happy_agent_event_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE happy_agent_active_runs(agent_id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
CREATE TABLE happy_agent_latest_events(agent_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,previous_event_id TEXT);
CREATE TABLE happy_agent_module_workspace_agents(workspace_id TEXT NOT NULL,agent_id TEXT PRIMARY KEY,order_key TEXT NOT NULL);
CREATE INDEX happy_agent_module_workspace_agents_workspace_order ON happy_agent_module_workspace_agents(workspace_id,order_key,agent_id);
CREATE TABLE happy_agent_module_projects(
    id TEXT PRIMARY KEY,repository_ref TEXT NOT NULL,runner_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,storage_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,name_source TEXT NOT NULL,
    status TEXT NOT NULL,presence TEXT NOT NULL,initialization_status TEXT NOT NULL,
    initialization_attempt BIGINT NOT NULL DEFAULT 0,initialization_error TEXT,default_branch TEXT,
    worktree_support TEXT NOT NULL DEFAULT 'unknown',worktree_unsupported_reason TEXT,
    remote_source_json TEXT,required_secret_kind TEXT,git_ahead BIGINT NOT NULL DEFAULT 0,
    git_behind BIGINT NOT NULL DEFAULT 0,git_detached INTEGER NOT NULL DEFAULT 0,git_branch TEXT,
    git_head TEXT,git_upstream TEXT,order_key TEXT NOT NULL,version BIGINT NOT NULL DEFAULT 1,
    avatar_json TEXT,description TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
    archived_at BIGINT,workspace_setup_commands_json TEXT,UNIQUE(runner_id,repository_ref)
);
CREATE INDEX happy_agent_module_projects_status_id ON happy_agent_module_projects(status,id);
CREATE INDEX happy_agent_module_projects_order_id ON happy_agent_module_projects(order_key,id);
CREATE TABLE happy_agent_module_project_root_agents(position INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,agent_id TEXT NOT NULL UNIQUE,order_key TEXT NOT NULL DEFAULT '');
CREATE INDEX happy_agent_module_project_root_agents_project_order ON happy_agent_module_project_root_agents(project_id,order_key,agent_id);
CREATE INDEX happy_agent_module_project_root_agents_project_position ON happy_agent_module_project_root_agents(project_id,position);
CREATE TABLE happy_agent_module_project_settings(project_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL);
CREATE TABLE happy_agent_module_project_avatars(project_id TEXT PRIMARY KEY,image_bytes BLOB NOT NULL,content_type TEXT NOT NULL,content_hash TEXT NOT NULL,thumbhash TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);