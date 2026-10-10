//! Configuration mutations stay with Config, Node and provider discovery.
use super::*;
impl ApiModule {
    pub(super) async fn configuration_route(self:&Arc<Self>,request:Request<Incoming>)->Response<Body>{
        let method=request.method().as_str().to_owned();let path=request.uri().path().to_owned();
        if method=="GET"&&path=="/v0/config"{return self.configuration_response().await;}
        if method=="PATCH"&&path=="/v0/config"{
            let body=match read_json(request).await{Ok(body)=>body,Err(response)=>return response};
            if !self.schemas.valid("ownerConfigPatch",&body).unwrap_or(false){return error(400,"invalid_request","The configuration patch is invalid.");}
            if !self.schemas.valid("ownerRuntimeConfigPatch",&body).unwrap_or(false){return error(409,"conflict","This daemon can only change provider enablement and its display name at runtime.");}
            if let Some(providers)=body.get("providers") {if let Some(id)=providers.as_object().and_then(|providers|providers.keys().find(|id|!self.config.provider_ids().contains(id))){return error(404,"not_found",&format!("Provider \"{id}\" is not configured."));}if let Err(failure)=self.provider_scan.set_overrides(providers).await{return internal(failure);}}
            let changed=if let Some(name)=body["node"]["name"].as_str(){let name=name.to_owned();let node=self.node.clone();match self.runtime.transact(move|ctx|{let previous=node.get(ctx)?;node.set_name(ctx,&name)?;Ok(previous["name"]!=name)}).await{Ok(changed)=>changed,Err(failure)=>return internal(failure)}}else{false};
            if body.get("providers").is_some()&&!changed{self.events.with_journal(|journal|journal.append("config.updated",json!({}),None));}
            return self.configuration_response().await;
        }
        if method=="POST"&&path=="/v0/providers/scan" {return match self.provider_scan.scan().await {Ok(result)=>{self.events.with_journal(|journal|journal.append("config.updated",json!({}),None));response(200,result)},Err(failure)=>internal(failure)};}
        if method=="POST"&&let Some(provider)=path.strip_prefix("/v0/providers/").and_then(|path|path.strip_suffix("/verify")).filter(|id|!id.contains('/')) {
            let provider=match percent_decode(provider){Ok(provider)=>provider,Err(_)=>return error(400,"invalid_request","The provider ID is invalid.")};
            if !self.config.provider_ids().contains(&provider){return error(404,"not_found",&format!("Provider \"{provider}\" is not configured."));}
            let body=match read_json(request).await{Ok(body)=>body,Err(response)=>return response};if !self.schemas.valid("ownerProviderVerificationRequest",&body).unwrap_or(false){return error(400,"invalid_request","The provider verification request is invalid.");}
            return match self.provider_scan.verify(&provider,body["level"].as_str().unwrap()).await{Ok(result)=>{if result["status"]=="passed"{self.events.with_journal(|journal|journal.append("config.updated",json!({}),None));}response(200,result)},Err(failure)=>internal(failure)};
        }
        error(404,"not_found","Not found.")
    }
    async fn configuration_response(&self)->Response<Body>{let node=self.node.clone();let config=self.config.clone();let presence=self.presence.clone();match self.runtime.transact(move|ctx|Ok(json!({"config":config.public_snapshot(node.get(ctx)?,presence.public_configuration(ctx)?)?}))).await{Ok(value)=>response(200,value),Err(failure)=>internal(failure)}}
}
fn percent_decode(value:&str)->anyhow::Result<String>{let bytes=value.as_bytes();let mut result=Vec::with_capacity(bytes.len());let mut index=0;while index<bytes.len(){if bytes[index]==b'%'{anyhow::ensure!(index+2<bytes.len(),"The encoded provider ID is incomplete.");let first=(bytes[index+1]as char).to_digit(16).ok_or_else(||anyhow::anyhow!("The encoded provider ID is invalid."))?;let second=(bytes[index+2]as char).to_digit(16).ok_or_else(||anyhow::anyhow!("The encoded provider ID is invalid."))?;result.push((first*16+second)as u8);index+=3;}else{result.push(bytes[index]);index+=1;}}Ok(String::from_utf8(result)?)}