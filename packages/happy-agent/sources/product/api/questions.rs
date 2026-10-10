//! Authenticated human answers and public questions share the owning transaction.
use super::*;
use anyhow::{Context as _,Result};
use crate::product::{runtime::Context,identity::resource_version};
fn resource(request:&Value,run:Option<&str>)->Value {
    let prompt=|id:Value,question:&Value|json!({"id":id,"header":question["header"].as_str().unwrap_or("Question"),"question":question["question"],"multiSelect":question["options"]["multiSelect"].as_bool().unwrap_or(false),"options":question["options"]["choices"].as_array().map(|choices|choices.iter().map(|choice|json!({"label":choice["label"],"description":choice["description"]})).collect::<Vec<_>>()).unwrap_or_default()});
    let questions=request["questions"].as_array().map(|questions|questions.iter().map(|question|prompt(question["id"].clone(),question)).collect::<Vec<_>>()).unwrap_or_else(||vec![prompt(request["id"].clone(),request)]);
    let values=|answer:&Value|->Vec<Value>{if let Some(text)=answer.as_str(){return vec![json!(text)];}let mut values=answer["selectedOptions"].as_array().cloned().unwrap_or_default();if let Some(text)=answer["text"].as_str(){values.push(json!(text));}values};
    let status=request["status"].as_str().unwrap_or("cancelled");
    let answers=if status!="answered"{Value::Null}else if let Some(answers)=request["answers"].as_object(){Value::Object(answers.iter().map(|(id,answer)|(id.clone(),json!(values(answer)))).collect())}else{json!({request["id"].as_str().unwrap():values(&request["answer"])})};
    json!({"id":request["id"],"agentId":request["askingAgentId"],"runId":run,"status":match status{"pending"=>"pending","answered"=>"answered",_=>"canceled"},"questions":questions,"autoResolveAt":request.get("deadlineAt").cloned().unwrap_or(Value::Null),"answers":answers,"version":resource_version(request["updatedAt"].as_u64().unwrap_or(0),match status{"pending"=>1,"answered"=>2,_=>3},request["id"].as_str().unwrap()),"createdAt":request["createdAt"],"answeredAt":if status=="answered"{request["answeredAt"].clone()}else{Value::Null}})
}
impl ApiModule {
    fn question_resource(&self,ctx:&Context<'_>,request:&Value,run:Option<&str>)->Result<Value> {
        let mut question=resource(request,run);
        if request["status"]=="answered"&&let Some(answers)=ctx.value(request["askingAgentId"].as_str().unwrap(),&format!("native.api.questionAnswers.{}",request["id"].as_str().unwrap()))? {
            anyhow::ensure!(self.schemas.valid("ownerQuestionAnswer",&json!({"answers":answers}))?,"The stored public question answer is invalid.");question["answers"]=answers;
        }
        Ok(question)
    }
    pub(super) fn start_question_events(self:&Arc<Self>)->Result<()> {
        let weak=Arc::downgrade(self);
        let subscription=self.user_input.on_event_transactional(Arc::new(move|ctx,event| {
            let Some(api)=weak.upgrade() else{return Ok(());};
            let request=&event["request"];let agent=request["askingAgentId"].as_str().context("The question owner is invalid.")?;
            let run=api.events.run_id(ctx,agent)?;let question=api.question_resource(ctx,request,run.as_deref())?;let at=event["at"].as_u64().context("The question event time is invalid.")?;
            if event["type"]=="user_input_requested" {
                let mut payload=json!({"question":question});mutation::apply(&mut payload);api.events.publish(ctx,"question.created",payload,at)?;
                api.agents.update_question_metadata(ctx,agent,Some(request["id"].as_str().unwrap()))?;
            } else {
                let mut payload=json!({"questionId":request["id"],"agentId":agent,"previousVersion":resource_version(request["createdAt"].as_u64().unwrap(),1,request["id"].as_str().unwrap()),"version":question["version"],"changes":{"status":question["status"],"answers":question["answers"],"answeredAt":question["answeredAt"],"updatedAt":request["updatedAt"]}});mutation::apply(&mut payload);api.events.publish(ctx,"question.updated",payload,at)?;
                api.agents.update_question_metadata(ctx,agent,None)?;
            }
            Ok(())
        }))?;
        self.question_events.set(subscription).map_err(|_|anyhow::anyhow!("The question event listener is already installed."))
    }
    pub(super) async fn question_route(self:&Arc<Self>,request:Request<Incoming>)->Response<Body> {
        let parts=request.uri().path().trim_start_matches("/v0/agents/").split('/').map(str::to_owned).collect::<Vec<_>>();
        let Some(agent)=parts.first().filter(|agent|self.schemas.valid("cuid2",&json!(agent)).unwrap_or(false)).cloned() else{return error(404,"not_found","Not found.");};
        if request.method()=="GET"&&parts.len()==2&&parts[1]=="question" {
            let owner=self.clone();return match self.runtime.transact(move|ctx| {if owner.agents.configuration(ctx,&agent)?.is_none(){return Ok(None);}let requests=owner.user_input.list_page(ctx,&agent,&json!({"askingAgentId":agent,"status":"pending","limit":1}))?;let run=owner.events.run_id(ctx,&agent)?;Ok(Some(json!({"question":requests["requests"][0].as_object().map(|_|resource(&requests["requests"][0],run.as_deref()))})))}).await{Ok(Some(value))=>response(200,value),Ok(None)=>error(404,"not_found","The agent was not found."),Err(failure)=>internal(failure)};
        }
        if request.method()!="POST"||parts.len()!=4||parts[1]!="question"||parts[3]!="answer"||!self.schemas.valid("ownerQuestionId",&json!(parts[2])).unwrap_or(false){return error(404,"not_found","Not found.");}
        let body=match read_json(request).await{Ok(body)=>body,Err(response)=>return response};
        if !self.schemas.valid("ownerQuestionAnswer",&body).unwrap_or(false){return error(400,"invalid_request","The question answer is invalid.");}
        let owner=self.clone();let id=parts[2].clone();
        match self.runtime.transact(move|ctx|mutation::with(body.get("mutationId").cloned(),||owner.answer_question(ctx,&agent,&id,&body))).await{Ok((status,value))=>response(status,value),Err(failure)=>internal(failure)}
    }
    fn answer_question(&self,ctx:&Context<'_>,agent:&str,id:&str,body:&Value)->Result<(u16,Value)> {
        if self.agents.configuration(ctx,agent)?.is_none(){return Ok((404,json!({"error":"The question was not found.","code":"not_found"})));}
        let Some(request)=self.user_input.get_owned(ctx,agent,id)? else{return Ok((404,json!({"error":"The question was not found.","code":"not_found"})));};
        if request["askingAgentId"]!=agent{return Ok((404,json!({"error":"The question was not found.","code":"not_found"})));}
        let run=self.events.run_id(ctx,agent)?;
        if request["status"]!="pending"{return Ok((409,json!({"error":"The question has already been resolved.","code":"conflict","question":self.question_resource(ctx,&request,run.as_deref())?})));}
        let ids=request["questions"].as_array().map(|questions|questions.iter().map(|question|question["id"].as_str().unwrap()).collect::<Vec<_>>()).unwrap_or_else(||vec![id]);
        let answers=body["answers"].as_object().context("The validated answers are unavailable.")?;
        if answers.len()!=ids.len()||ids.iter().any(|id|!answers.contains_key(*id)){return Ok((400,json!({"error":"Every question in the batch must receive an answer.","code":"invalid_request"})));}
        let answer=|prompt:&Value,values:&Value| {let values=values.as_array().expect("validated answer values");if values.len()==1{return values[0].clone();}let mut selected=Vec::new();let mut text=Vec::new();for value in values {if prompt["options"]["choices"].as_array().is_some_and(|choices|choices.iter().any(|choice|choice["label"]==*value)){selected.push(value.clone());}else{text.push(value.as_str().expect("validated free text"));}}let mut answer=json!({});if !selected.is_empty(){answer["selectedOptions"]=json!(selected);}if !text.is_empty(){answer["text"]=json!(text.join("\n"));}answer};
        let input=if request.get("questions").is_none(){json!({"requestId":id,"answer":answer(&request,&answers[id])})}else{json!({"requestId":id,"answers":request["questions"].as_array().unwrap().iter().map(|prompt|{let id=prompt["id"].as_str().unwrap();(id.to_owned(),answer(prompt,&answers[id]))}).collect::<serde_json::Map<_,_>>()})};
        // Only this authenticated transport path records human evidence. The
        // owner validates the answer and claims it in this same transaction.
        if self.user_input.validate_answer(ctx,agent,&input).is_err(){return Ok((400,json!({"error":"The question answer is invalid.","code":"invalid_request"})));}
        // The public array is canonical answer data, retained with its terminal
        // request so a late client sees the exact first accepted values.
        ctx.put_value(agent,&format!("native.api.questionAnswers.{id}"),&body["answers"])?;
        let answered=self.user_input.answer(ctx,agent,&input)?;
        self.auto.record_human_answer(ctx,agent,id,&body["answers"].to_string())?;
        Ok((200,json!({"question":self.question_resource(ctx,&answered,run.as_deref())?})))
    }
}
#[cfg(test)]
mod tests{use super::*;#[test]fn public_questions_match_all_shipped_resource_goldens(){let cases:Value=serde_json::from_str(include_str!("question_goldens.json")).unwrap();for case in cases.as_array().unwrap(){assert_eq!(resource(&case["request"],case["runId"].as_str()),case["expected"]);}}}