mod anthropic;
mod chat_completions;
mod responses;
pub(crate) mod stream;

pub(crate) use anthropic::anthropic_request;
pub(crate) use chat_completions::chat_request;
pub(crate) use responses::{responses_lite_request, responses_request};

use crate::{Block, Message};
pub(crate) fn notice(message: &Message) -> Option<Vec<Block>> {
    match message {
        Message::System { content } => Some(content.clone()),
        Message::Agent { author, content } => {
            let mut blocks = vec![Block::text(format!(
                "Message from agent {} ({}):",
                author.description, author.id
            ))];
            blocks.extend(content.clone());
            Some(blocks)
        }
        _ => None,
    }
}
pub(crate) fn text(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}
