import { $ } from '../core/dom.js';
import { toggleSettings, loadMcp, loadTools } from './settings.js';
import { openAutomations } from './automations.js';
import { loadUsage } from './usage.js';
import { loadAdmin } from './admin.js';

const settings = $('settings');
const automations = $('automations');
const statistics = $('statistics');
const mcp = $('mcp');
const mcpBtn = $('toggle-mcp');
const automationsBtn = $('toggle-automations');
const statisticsBtn = $('toggle-statistics');
const admin = $('admin');
const adminBtn = $('toggle-admin');

function closeOtherPanels(except) {
  if (except !== settings) toggleSettings(false, { focusComposer: false });
  if (except !== automations) { automations.classList.remove('open'); automationsBtn.classList.remove('active'); }
  if (except !== mcp) { mcp.classList.remove('open'); mcpBtn.classList.remove('active'); }
  if (except !== statistics) { statistics.classList.remove('open'); statisticsBtn.classList.remove('active'); }
  if (except !== admin) { admin.classList.remove('open'); adminBtn.classList.remove('active'); }
}

$('toggle-settings').onclick = () => {
  const opening = !settings.classList.contains('open');
  closeOtherPanels(settings);
  toggleSettings(opening);
};

$('toggle-automations').onclick = async () => {
  const opening = !automations.classList.contains('open');
  closeOtherPanels(automations);
  automations.classList.toggle('open', opening);
  automationsBtn.classList.toggle('active', opening);
  if (opening) await openAutomations();
};

$('toggle-statistics').onclick = async () => {
  const opening = !statistics.classList.contains('open');
  closeOtherPanels(statistics);
  statistics.classList.toggle('open', opening);
  statisticsBtn.classList.toggle('active', opening);
  if (opening) await loadUsage();
};

$('toggle-admin').onclick = async () => {
  const opening = !admin.classList.contains('open');
  closeOtherPanels(admin);
  admin.classList.toggle('open', opening);
  adminBtn.classList.toggle('active', opening);
  if (opening) await loadAdmin();
};
$('close-admin').onclick = () => { admin.classList.remove('open'); adminBtn.classList.remove('active'); };

// MCP servers: the config editor and tool list, moved out of Settings.
// Reloaded on open so it reflects any toggles made from the composer menu.
$('toggle-mcp').onclick = async () => {
  const opening = !mcp.classList.contains('open');
  closeOtherPanels(mcp);
  mcp.classList.toggle('open', opening);
  mcpBtn.classList.toggle('active', opening);
  if (opening) await Promise.all([loadMcp(), loadTools()]);
};
$('close-mcp').onclick = () => { mcp.classList.remove('open'); mcpBtn.classList.remove('active'); };

$('close-statistics').onclick = () => { statistics.classList.remove('open'); statisticsBtn.classList.remove('active'); };
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { mcp.classList.remove('open'); mcpBtn.classList.remove('active'); }
  if (event.key === 'Escape') { statistics.classList.remove('open'); statisticsBtn.classList.remove('active'); }
  if (event.key === 'Escape') { admin.classList.remove('open'); adminBtn.classList.remove('active'); }
});
