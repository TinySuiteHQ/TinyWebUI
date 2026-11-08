/*
 * The built-in tool contract. Each file in this folder exports `xToolDef()`,
 * the definition the model is offered, and `callX(args, deps)`, which returns
 * the result text. server.js registers the pair on the hub (registerLocal in
 * mcp.js), handing each handler the call's context plus what it depends on.
 */
import type { ToolDef } from '../harness/types.ts';
import type { Store } from '../store/index.ts';

export type { ToolDef };

/** A call's arguments as the model wrote them: parsed JSON, nothing checked yet. */
export type ToolArgs = Record<string, any>;

/** A question ask_user puts to the user, and how it ended. */
export interface AskRequest { question: string; choices: string[]; allowFreeText: boolean }
export type AskOutcome =
  | { answered: true; answer: string }
  | { answered: false; reason: string };

/** What every call is handed beside its arguments (toolCtx in chat/tool_executor.js). */
export interface ToolContext {
  store: Store;
  chatId: string;
  /** Characters one result may return. */
  budget: number;
  /** No one is there to ask: an automation run. */
  unattended: boolean;
  askUser: ((request: AskRequest) => Promise<AskOutcome>) | null;
  /**
   * The owner of the chat this call runs in, from the store -- never from
   * the model or the browser. null in a no-login install. Per-user MCP
   * servers act for this user (McpHub.clientFor).
   */
  userId?: string | null;
}

/** A registered handler. Whatever it returns becomes the result text. */
export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => unknown;
