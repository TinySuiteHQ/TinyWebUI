/*
 * The wire shapes the harness speaks: OpenAI-compatible chat messages, tool
 * definitions and calls, the request body and the streamed chunks. Types only;
 * the app imports them for its own rows and tools.
 */
import type { EVENT } from '../../public/shared/events.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A built-in or MCP tool as the model is offered it. */
export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface CacheDirective { type: 'ephemeral'; ttl?: '1h' }

/** One part of array content: text, an image, or whatever else a gateway accepts. */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  cache_control?: CacheDirective;
}

export type Content = string | ContentPart[] | null;

/** Structured reasoning, which some providers need echoed back verbatim. */
export interface ReasoningDetail {
  index?: number;
  text?: string;
  summary?: string;
  [key: string]: unknown;
}

/** A message as the harness handles it, before `canonical` shapes it for the wire. */
export interface ChatMessage {
  role: Role;
  content: Content;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
}

/** A message exactly as it is sent. */
export interface WireMessage {
  role: Role;
  content: Content;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_details?: ReasoningDetail[];
  reasoning_content?: string;
}

/**
 * A provider's usage object. Nothing in it is standardised (see
 * public/shared/usage.js); these are the fields read directly.
 */
export interface Usage {
  cost?: number;
  cost_currency?: string;
  reasoning_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  [key: string]: unknown;
}

export interface ProviderRoute {
  order?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  [key: string]: unknown;
}

/** Operator fields merged into every request body, gateway routing among them. */
export interface ExtraBody {
  provider?: ProviderRoute;
  [key: string]: unknown;
}

export type CacheMode = 'auto' | 'implicit' | 'explicit' | 'rolling' | 'off';
export type ReasoningReplay = 'auto' | 'omit' | 'reasoning_content' | 'reasoning_details';

/** The part of the config a provider request reads. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  cache?: boolean;
  cacheMode?: CacheMode;
  cacheTtl?: string;
  reasoningReplay?: ReasoningReplay;
  extraBody?: ExtraBody;
  temperature?: number | null;
  maxTokens?: number | null;
  compactionMaxTokens?: number;
}

export interface RequestBody {
  model: string;
  messages: WireMessage[];
  stream: true;
  provider?: ProviderRoute;
  session_id?: string;
  cache_control?: CacheDirective;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  tool_choice?: 'none';
  [key: string]: unknown;
}

/** One model request: the turn so far and what it may call. */
export interface RequestPlan {
  turn: ChatMessage[];
  tools: ToolDef[];
  lastCall: boolean;
  epochIndex: number;
  chatId?: string;
  relax?: boolean;
  onRequest?: (body: RequestBody) => void;
}

/** One parsed `data:` line of the completion stream. */
export interface Chunk {
  usage?: Usage;
  provider?: string;
  error?: { message?: string };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: ReasoningDetail[];
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

export type EventType = (typeof EVENT)[keyof typeof EVENT];

/** A stream event for the page; see public/shared/events.js. */
export interface StreamEvent {
  type: EventType;
  [key: string]: unknown;
}

export type Emit = (event: StreamEvent) => void;
