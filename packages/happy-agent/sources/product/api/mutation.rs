//! Synchronous transaction hooks retain the API request's opaque correlation value.
use serde_json::Value;
use std::cell::RefCell;
thread_local! {static CURRENT:RefCell<Option<Value>>=const{RefCell::new(None)};}
pub(super) fn with<T>(value:Option<Value>,work:impl FnOnce()->T)->T {
    struct Restore(Option<Value>);impl Drop for Restore{fn drop(&mut self){CURRENT.with(|current|*current.borrow_mut()=self.0.take());}}
    let _restore=Restore(CURRENT.with(|current|current.replace(value)));work()
}
pub(super) fn apply(payload:&mut Value){if let Some(value)=CURRENT.with(|current|current.borrow().clone()){payload["mutationId"]=value;}}