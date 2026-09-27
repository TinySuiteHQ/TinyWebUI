/** Per-run MCP inventory. Only the already-authorized tools can enter a group. */
export const LOAD_CAPABILITIES = 'load_capabilities';

export function capabilitySession({ tools, hub, enabled = false, loaderDisabled = false }) {
  const groups = new Map();
  const core = [];
  for (const tool of tools) {
    const server = hub?.routes?.get(tool.function.name)?.server;
    if (!server) { core.push(tool); continue; }
    if (!groups.has(server)) groups.set(server, []);
    groups.get(server).push(tool);
  }
  const names = [...groups.keys()].sort();
  const lazy = enabled && names.length > 0;
  const loaded = new Set(lazy ? [] : names);
  const discovery = {
    type: 'function',
    function: {
      name: LOAD_CAPABILITIES,
      description: 'Load additional tool capabilities for this run. Load only what the task requires; their tools become available next round.',
      parameters: { type: 'object', properties: {
        capabilities: { type: 'array', items: { type: 'string', enum: names }, minItems: 1 }
      }, required: ['capabilities'], additionalProperties: false }
    }
  };
  const guidance = lazy && !loaderDisabled ? ['# Available capabilities',
    'Use load_capabilities when needed. Do not load speculatively. Loaded tools remain available for this run.',
    ...names.map((name) => {
      const description = hub?.servers?.[name]?.capabilityDescription;
      return `- ${name}: ${description || groups.get(name).map((t) => hub.routes.get(t.function.name).tool).join(', ')}`;
    })].join('\n') : '';
  return {
    guidance,
    tools: () => lazy ? [...core, ...(loaderDisabled ? [] : [discovery]), ...names.filter((n) => loaded.has(n)).flatMap((n) => groups.get(n))] : tools,
    servers: () => names.filter((n) => loaded.has(n)),
    owner: (name) => hub?.routes?.get(name)?.server || 'built-ins',
    isLoader: (name) => lazy && !loaderDisabled && name === LOAD_CAPABILITIES,
    load(args) {
      if (!lazy || loaderDisabled) return 'Error: capability loading is disabled for this run.';
      const requested = args?.capabilities;
      if (!Array.isArray(requested) || !requested.length || requested.some((n) => typeof n !== 'string' || !groups.has(n))) {
        return 'Error: choose one or more available capability names. No capabilities were loaded.';
      }
      for (const name of requested) loaded.add(name);
      return `Loaded capabilities: ${names.filter((n) => loaded.has(n)).join(', ')}. Their tools and guidance are available next round.`;
    }
  };
}
