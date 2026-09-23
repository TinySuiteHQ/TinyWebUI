import { $ } from './dom.js';
import { toggleSettings } from './settings.js';
import { openAutomations } from './automations.js';
import { loadUsage } from './usage.js';

const settings = $('settings');
const automations = $('automations');
const statistics = $('statistics');

function closeOtherPanels(except) {
  if (except !== settings) toggleSettings(false);
  if (except !== automations) automations.classList.remove('open');
  if (except !== statistics) statistics.classList.remove('open');
}

$('toggle-settings').onclick = () => {
  const opening = !settings.classList.contains('open');
  closeOtherPanels(settings);
  toggleSettings(opening);
};

$('toggle-automations').onclick = async () => {
  const opening = !automations.classList.contains('open');
  closeOtherPanels(automations);
  if (opening) await openAutomations();
};

$('toggle-statistics').onclick = async () => {
  const opening = !statistics.classList.contains('open');
  closeOtherPanels(statistics);
  statistics.classList.toggle('open', opening);
  if (opening) await loadUsage();
};

$('close-statistics').onclick = () => statistics.classList.remove('open');
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') statistics.classList.remove('open');
});
