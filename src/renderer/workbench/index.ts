import './widgets/deep-focus';
import './widgets/task-flow';
import './widgets/search';
import './widgets/agents';
import './widgets/command-center';
import './widgets/widget-forge';
import './widgets/info-radar';
import './widgets/artifact';
import './widgets/evolution';
import { initLayout, addWidget } from './core/layout';
import { initActions } from './core/actions';
import { initToast } from './core/toast';
import { initPalette, openPalette, closePalette } from './core/palette';

// clock
const clock = document.getElementById('clock')!;
function tick() {
  clock.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
}
tick();
setInterval(tick, 1000);

// palette triggers
document.getElementById('btn-palette')!.onclick = () => openPalette();
document.getElementById('btn-agents')!.onclick = () => addWidget('agents');
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  } else if (e.key === 'Escape') {
    closePalette();
  }
});

void initLayout().then(() => {
  initPalette();
  initActions();
  initToast();
  // first run: place the two core widgets
  if (!document.querySelector('.widget')) {
    addWidget('task-flow');
    addWidget('deep-focus');
  }
});
