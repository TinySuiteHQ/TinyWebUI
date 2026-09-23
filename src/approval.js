/**
 * Which tool calls wait for the user before they run.
 *
 * The model decides what to call; this decides whether that decision is final.
 * Reading is free -- the system prompt tells the model to look things up
 * without asking -- so the default only stops calls that can change something.
 * "Can change something" comes from the tool itself: MCP tools declare it with
 * the readOnlyHint annotation. A tool that says nothing is assumed to write. That is the cautious reading,
 * and "always allow" on the prompt is one click for a tool that is trusted.
 *
 *   'writes'  ask before any call not declared read-only (default)
 *   'all'     ask before every call
 *   'off'     never ask
 *
 * Built-in tools (context_expand, read_document, manage_automation) are the
 * harness's own and always run; everything here applies to MCP tools.
 *
 * Per-tool overrides win over the mode: `confirmTools` always asks,
 * `autoApproveTools` never does.
 */
export const APPROVAL_MODES = ['writes', 'all', 'off'];

/** 'ask' or 'auto' for one concrete call. */
export function approvalFor(cfg, hub, name, args) {
  // The harness's own tools are part of the harness, not third-party code:
  // they never ask, whatever the mode or overrides say. Approval is for MCP.
  if (hub?.isLocal?.(name)) return 'auto';
  if ((cfg.confirmTools || []).includes(name)) return 'ask';
  if ((cfg.autoApproveTools || []).includes(name)) return 'auto';
  // Missing means off, not the config default: a caller that builds its own
  // cfg (tests, evals) has no one to ask and must not stall waiting for one.
  const mode = cfg.toolApproval || 'off';
  if (mode === 'off') return 'auto';
  if (mode === 'all') return 'ask';
  return hub?.isReadOnly?.(name, args) ? 'auto' : 'ask';
}

/** The per-tool override the settings panel shows: 'ask', 'auto' or 'default'. */
export function overrideFor(cfg, name) {
  if ((cfg.confirmTools || []).includes(name)) return 'ask';
  if ((cfg.autoApproveTools || []).includes(name)) return 'auto';
  return 'default';
}

/** The config patch that sets one tool's override. */
export function setOverride(cfg, name, policy) {
  const confirm = new Set(cfg.confirmTools || []);
  const auto = new Set(cfg.autoApproveTools || []);
  confirm.delete(name);
  auto.delete(name);
  if (policy === 'ask') confirm.add(name);
  if (policy === 'auto') auto.add(name);
  return { confirmTools: [...confirm], autoApproveTools: [...auto] };
}
