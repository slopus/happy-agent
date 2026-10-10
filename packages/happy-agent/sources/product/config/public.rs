//! The public configuration projects declared values and never credentials.
use super::*;
use serde_json::{Value,json};
impl ConfigModule {
    pub fn public_snapshot(&self,node:Value)->Result<Value> {
        let mut values=self.values.clone();merge(&mut values,self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone());
        let section=|name:&str|camel(&toml_json(values.get(name).unwrap_or(&toml::Value::Table(toml::map::Map::new()))));
        let routes=self.configured_models()?;let mut models=serde_json::Map::new();let mut providers=serde_json::Map::new();
        for provider in self.provider_ids(){providers.insert(provider.clone(),json!({"type":self.provider_type(&provider).unwrap_or("codex"),"enabled":self.provider_enabled(&provider),"hidden":values["providers"][&provider].get("hidden").and_then(toml::Value::as_bool).unwrap_or(false),"models":[]}));}
        for route in &routes {
            let id=route["id"].as_str().context("The model identity is missing.")?;
            let tiers=route["serviceTiers"].as_array().cloned().unwrap_or_default();let options=service_options(&tiers)?;
            let candidate=json!({"name":route["name"],"contextWindow":route.get("contextWindow").unwrap_or(&Value::Null),"autoCompactWindow":route.get("autoCompactWindow").unwrap_or(&Value::Null),"efforts":route["effortLevels"],"defaultEffort":route["defaultEffort"],"serviceTiers":tiers,"serviceTierOptions":options});
            let richness=|model:&Value|model["efforts"].as_array().map_or(0,Vec::len)+model["serviceTiers"].as_array().map_or(0,Vec::len);
            if models.get(id).is_none_or(|existing|richness(&candidate)>richness(existing)){models.insert(id.to_owned(),candidate);}
        }
        for route in &routes {
            let id=route["id"].as_str().unwrap();let provider=route["providerId"].as_str().unwrap();let definition=&models[id];let tiers=route["serviceTiers"].as_array().cloned().unwrap_or_default();
            let mut model=json!({"id":id,"enabled":self.mode_available(&json!({"providerId":provider,"modelId":id,"effort":route["defaultEffort"],"serviceTier":null})),"serviceTierOptions":service_options(&tiers)?});
            for (source,target) in [("effortLevels","efforts"),("defaultEffort","defaultEffort"),("name","name")] {if route[source]!=definition[target]{model[target]=route[source].clone();}}
            if json!(tiers)!=definition["serviceTiers"]{model["serviceTiers"]=json!(tiers);}
            providers.get_mut(provider).context("The model account is missing.")?["models"].as_array_mut().context("The public model list is invalid.")?.push(model);
        }
        let default=self.naming_models()?.into_iter().next().or_else(||self.offered_models().ok()?.into_iter().next());let configured=section("defaults");let mut defaults=json!({"permissionMode":configured["permissionMode"]});
        for (output,field,input) in [("providerId","providerId","provider"),("modelId","id","model"),("effort","defaultEffort","effort")] {if let Some(value)=default.as_ref().and_then(|model|model.get(field)).or_else(||configured.get(input)){defaults[output]=value.clone();}}
        // MCP servers come only from mcp.toml; happy.toml cannot declare them.
        let mcp:serde_json::Map<String,Value>=self.mcp_servers().into_iter().map(|(name,server)|(name,json!({"enabled":server.get("enabled").and_then(Value::as_bool).unwrap_or(true),"transport":server["transport"]}))).collect();
        let network=section("network");let network=json!({"allowedDomains":network.get("allowedDomains").cloned().unwrap_or(json!([])),"deniedDomains":network.get("deniedDomains").cloned().unwrap_or(json!([])),"allowedPorts":network.get("allowedPorts").cloned().unwrap_or(json!([])),"allowedLoopbackPorts":network.get("allowedLoopbackPorts").cloned().unwrap_or(json!([])),"allowLocalBinding":network["allowLocalBinding"].as_bool().unwrap_or(false)});
        let p2p=section("p2p");let p2p=select(&p2p,&["name","role","enableIroh","enableDirect","enableSsh","exposeApi"]);let settings=section("settings");let settings=select(&settings,&["compactCompletedTurns","completionChime","inferenceMaxRetries","showReasoning","showUsage","toolResultRetentionDays"]);
        let snapshot=json!({"node":node,"defaults":defaults,"features":section("features"),"mcpServers":mcp,"network":network,"p2p":p2p,"permissions":section("permissions"),"presence":self.presence_configuration()?,"models":models,"providers":providers,"settings":settings,"theme":section("theme"),"workspace":section("workspace")});
        anyhow::ensure!(super::super::schemas::Schemas::new()?.valid("ownerConfigResponse",&json!({"config":snapshot}))?,"The public configuration is invalid.");Ok(snapshot)
    }
}
fn camel(value:&Value)->Value {match value{Value::Object(values)=>Value::Object(values.iter().map(|(key,value)|{let mut output=String::new();let mut upper=false;for character in key.chars(){if character=='_'{upper=true;}else if upper{output.push(character.to_ascii_uppercase());upper=false;}else{output.push(character);}}(output,camel(value))}).collect()),Value::Array(values)=>Value::Array(values.iter().map(camel).collect()),value=>value.clone()}}
fn select(value:&Value,fields:&[&str])->Value {Value::Object(fields.iter().filter_map(|field|value.get(*field).map(|value|((*field).to_owned(),value.clone()))).collect())}
fn service_options(tiers:&[Value])->Result<Value> {let mut options=vec![json!({"id":null,"label":"Regular"})];for tier in tiers{if options.iter().any(|option|option["id"]==*tier){continue;}let label=match tier.as_str(){Some("priority")=>"Fast",Some("ultrafast")=>"Ultrafast",_=>anyhow::bail!("The service tier has no configured display label.")};options.push(json!({"id":tier,"label":label}));}Ok(json!(options))}