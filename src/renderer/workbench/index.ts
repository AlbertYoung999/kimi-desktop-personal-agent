import './widgets/deep-focus';
import './widgets/task-flow';
import './widgets/search';
import './widgets/agents';
import './widgets/command-center';
import './widgets/widget-forge';
import './widgets/info-radar';
import './widgets/artifact';
import './widgets/evolution';
import './widgets/phone-video';
import { initLayout, addWidget, refreshStage } from './core/layout';
import { allWidgets } from './core/registry';
import { initActions } from './core/actions';
import { initPresenter } from './core/presenter';
import { initToast } from './core/toast';
import { initReaction } from './core/reaction';
import { initPalette, openPalette, closePalette } from './core/palette';
import { initNav } from './core/nav';
import { initVoice } from './core/voice';
import { initMainLog } from './core/main-log';
import { initHomePage } from './pages/home';
import { initZenPage } from './pages/zen';
import { initPluginsPage } from './pages/plugins';
import { initAgentsPage } from './pages/agents';

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

// nav rail + pages（V4-A Shell）：页面常驻 DOM，切换只是显隐
initNav((item) => {
  // dashboard 从 display:none 恢复时重算画布尺寸
  if (item.id === 'dashboard') refreshStage();
});
initHomePage();
initZenPage();
initPluginsPage();
initAgentsPage();
initVoice();
initMainLog();

window.kimi.wbRegisterWidgets(allWidgets().map((w) => ({ id: w.def.id, name: w.def.name, description: w.def.description })));

void initLayout().then(() => {
  initPalette();
  initActions();
  initPresenter();
  initToast();
  initReaction();
  // first run: place the two core widgets
  if (!document.querySelector('.widget')) {
    addWidget('task-flow');
    addWidget('deep-focus');
  }
});
