/**
 * State shared across the split-up UI modules.
 *
 * A single mutable object rather than several exported `let`s: every module
 * that needs to read or write `state.chat` (or `.busy`, `.viewCtrl`, ...) just
 * imports this one object, and since its identity never changes, plain
 * property assignment from any module is visible to all the others -- no
 * setter functions or live-binding subtleties to keep track of.
 */
export const state = {
  chat: null,       // { id, title } -- the conversation currently on screen
  busy: false,      // a turn is streaming into the view right now
  // The fetch reading a run's stream belongs to whichever view started it.
  // Switching chats aborts it -- see leaveView() in chat.js.
  viewCtrl: null,
  chats: [],        // the sidebar's chronological chat list
  folders: [],      // every known folder name, including empty ones

  // Uploaded before the message that references them is sent, so a slow
  // upload doesn't block typing. Cleared once that turn is sent.
  pendingAttachments: [], // [{id, filename, char_len, pending}]

  // Every document ever attached to the chat currently open, shown in the
  // artifacts strip above the transcript. Not the same list as
  // pendingAttachments, which is only what hasn't been sent yet.
  chatDocuments: [],      // [{id, filename, char_len}]
  // Every image ever attached to the chat currently open, shown in the same
  // strip. Derived from message history rather than stored separately.
  chatImages: []          // [{filename, mime, data}]
};
