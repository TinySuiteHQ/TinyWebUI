/**
 * What the tool controls on the MCP page do. Every change redraws from the
 * fresh /api/tools payload the server answers with, so the page never drifts
 * from what the server actually did.
 */
import { api } from '../../core/api.ts';
import { useConfig } from '../../stores/config.ts';
import { useChat } from '../../stores/chat.ts';
import type { ToolOverride, ToolsReply, ToolView } from '../../../../shared/api.ts';

export function useToolActions() {
  const config = useConfig();
  const chat = useChat();

  async function run(call: () => Promise<ToolsReply>) {
    try { config.tools = await call(); } catch (err) { chat.addError(err.message); config.loadTools(); }
  }
  const toggleTool = (name: string, disabled: boolean) => run(() => api.post<ToolsReply>('/api/tools/toggle', { name, disabled }));
  const setApproval = (name: string, policy: ToolOverride) => run(() => api.post<ToolsReply>('/api/tools/approval', { name, policy }));
  const retry = (name: string) => run(() => api.post<ToolsReply>(`/api/mcp/servers/${encodeURIComponent(name)}/retry`, {}));
  async function toggleServer(name: string, disabled: boolean) {
    await run(() => api.post<ToolsReply>(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`, { disabled }));
    config.loadMcp(); // the raw editor's disabled: true/false has to catch up too
  }

  // What "default" resolves to for a tool under the global mode, so the select
  // says what will actually happen.
  function defaultApproval(t: ToolView) {
    const mode = config.tools?.toolApproval || 'writes';
    if (mode === 'off') return 'never';
    if (mode === 'all') return 'ask';
    return t.readOnly === true ? 'never (read-only)' : 'ask (may write)';
  }

  return { toggleTool, setApproval, retry, toggleServer, defaultApproval };
}

/** "5/6 on": how many of these tools the model is offered. */
export const onCount = (tools: ToolView[]) => `${tools.filter((t) => !t.disabled).length}/${tools.length} on`;
