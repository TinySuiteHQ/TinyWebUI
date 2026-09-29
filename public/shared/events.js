/**
 * The events a running turn streams to the browser, as `data: {"type": ...}`
 * lines. Shared by both sides: the server imports this file to emit them
 * (src/chat/runs.js, llm.js, tool_executor.js, agent.js) and the page imports
 * it to handle them (stream.js). It lives in public/shared/ because that is the one
^ * place both can load. A test checks that stream.js handles every one.
 */
export const EVENT = Object.freeze({
  CHAT: 'chat',                     // the run's chat id and title, first on every stream
  USER: 'user',                     // a user message the run added (queued follow-up, steering)
  QUEUE: 'queue',                   // what is waiting to be sent into this chat
  NEXT_RUN: 'next_run',             // a queued follow-up is starting as a new run
  REASONING: 'reasoning',           // a chunk of the model's thinking
  TEXT: 'text',                     // a chunk of the model's answer
  TOOL_CALL: 'tool_call',           // the model called a tool
  TOOL_RESULT: 'tool_result',       // that call's result
  APPROVAL: 'approval',             // a call waits for the user's allow / deny
  APPROVAL_DONE: 'approval_done',   // the user decided
  QUESTION: 'question',             // ask_user put a question to the user
  QUESTION_DONE: 'question_done',   // it was answered, skipped, timed out or cancelled
  TASKS: 'tasks',                   // the chat's checklist changed
  COMPACTED: 'compacted',           // older context was compacted this turn
  USAGE: 'usage',                   // token usage for one model round
  NOTICE: 'notice',                 // something worth telling the user, not an error
  ERROR: 'error',                   // the run failed or was stopped
  DONE: 'done'                      // the turn finished
});
