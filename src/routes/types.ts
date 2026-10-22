/*
 * The route table's shapes. Each file in this folder exports a factory that
 * takes the part of RouteDeps it uses and returns a list of routes; server.js
 * concatenates them into the one table that is both dispatch and permission.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Auth, SignedIn } from '../access/auth_gate.ts';
import type { Feature } from '../access/policy.ts';
import type { Store } from '../store/index.ts';
import type { UserRole } from '../store/users.ts';
import type { Config, ConfigSource, McpServers } from '../config/config.ts';
import type { McpHub } from '../mcp.ts';
import type { Retrieval } from '../retrieval/retrieval.ts';
import type { Runs } from '../chat/runs.ts';
import type { Scheduler } from '../automations/scheduler.ts';
import type { ToolDef } from '../harness/types.ts';

export interface RouteContext<A extends Auth = Auth> {
  req: IncomingMessage;
  res: ServerResponse;
  auth: A;
  url: URL;
  /** The path pattern's capture groups. */
  params: string[];
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Behind a feature: only someone holding it gets here, so `auth` has a scope. */
interface FeatureRoute {
  method: Method;
  path: RegExp;
  feature: Feature;
  handle(ctx: RouteContext<SignedIn>): unknown;
}

/** Open to whoever the auth gate let through, signed in or not. */
interface OpenRoute {
  method: Method;
  path: RegExp;
  feature: null;
  handle(ctx: RouteContext): unknown;
}

/** Every route declares `feature`; leaving it out does not compile. */
export type Route = FeatureRoute | OpenRoute;

/**
 * What route groups may ask for (routeTable in server.js). config, hub and
 * passwordHash change at runtime, so they are read through accessors.
 */
export interface RouteDeps {
  store: Store;
  runs: Runs;
  scheduler: Scheduler;
  retrieval: Retrieval;
  source: ConfigSource;
  version: string;
  config(): Config;
  hub(): McpHub;
  passwordHash(): string | undefined;
  saveConfig(patch: Record<string, unknown>, by?: string): Config;
  refreshConfig(): void;
  auditMcp(by: string, before: string): void;
  swapHub(servers: McpServers): Promise<void>;
  multiUser(): boolean;
  modelFor(userId: string | null | undefined, role: UserRole | null | undefined): string;
  instructionsFor(userId: string | null | undefined): string | null;
  toolsFor(features: Set<string>): ToolDef[];
  toolsView(): unknown;
  configFor(auth: Auth): Record<string, unknown>;
}
