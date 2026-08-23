/**
 * 官方预设 artifact（V4-B Plugins 市场）：自包含 HTML（内联 style + script），
 * 符合 artifact 自包含规范——脚本由 artifact 挂载逻辑注入并绑定作用域 document
 * （getElementById 只在宿主内查找，多实例共存不冲突）。
 */

export interface PresetArtifact {
  id: string;
  title: string;
  description: string;
  html: string;
}

const WORLD_CLOCK_HTML = `
<div class="pz-clock">
  <div class="pz-clock-row" data-tz="Asia/Shanghai"><span class="pz-city">上海</span><span class="pz-time" id="pz-t0">--:--:--</span><span class="pz-date" id="pz-d0"></span></div>
  <div class="pz-clock-row" data-tz="Europe/London"><span class="pz-city">伦敦</span><span class="pz-time" id="pz-t1">--:--:--</span><span class="pz-date" id="pz-d1"></span></div>
  <div class="pz-clock-row" data-tz="America/New_York"><span class="pz-city">纽约</span><span class="pz-time" id="pz-t2">--:--:--</span><span class="pz-date" id="pz-d2"></span></div>
  <div class="pz-clock-row" data-tz="Asia/Tokyo"><span class="pz-city">东京</span><span class="pz-time" id="pz-t3">--:--:--</span><span class="pz-date" id="pz-d3"></span></div>
</div>
<style>
  .pz-clock { display: flex; flex-direction: column; gap: 8px; font-family: "SF Mono", Menlo, monospace; }
  .pz-clock-row { display: flex; align-items: baseline; gap: 10px; padding: 8px 10px; border: 1px solid rgba(0,240,255,0.15); border-radius: 8px; background: rgba(0,240,255,0.04); }
  .pz-city { width: 40px; font-size: 12px; color: #7d8590; }
  .pz-time { flex: 1; font-size: 20px; color: #00f0ff; text-shadow: 0 0 12px rgba(0,240,255,0.4); }
  .pz-date { font-size: 10px; color: #7d8590; }
</style>
<script>
  var pzRows = [['Asia/Shanghai', 0], ['Europe/London', 1], ['America/New_York', 2], ['Asia/Tokyo', 3]];
  function pzTick() {
    var now = new Date();
    for (var i = 0; i < pzRows.length; i++) {
      var tz = pzRows[i][0], idx = pzRows[i][1];
      var t = document.getElementById('pz-t' + idx);
      var d = document.getElementById('pz-d' + idx);
      if (!t || !d) continue;
      t.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
      d.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', weekday: 'short' }).format(now);
    }
  }
  pzTick();
  setInterval(pzTick, 1000);
</script>
`;

const TODO_HTML = `
<div class="pz-todo">
  <div class="pz-todo-input-row">
    <input id="pz-todo-input" type="text" placeholder="新待办，回车添加…" autocomplete="off" />
    <button id="pz-todo-add">＋</button>
  </div>
  <ul id="pz-todo-list"></ul>
</div>
<style>
  .pz-todo { font-family: "SF Mono", Menlo, monospace; font-size: 12px; color: #dde3ea; }
  .pz-todo-input-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .pz-todo-input-row input { flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(0,240,255,0.2); border-radius: 6px; color: #dde3ea; padding: 6px 10px; font: inherit; outline: none; }
  .pz-todo-input-row input:focus { border-color: rgba(0,240,255,0.5); }
  .pz-todo-input-row button { background: rgba(0,240,255,0.1); border: 1px solid rgba(0,240,255,0.3); border-radius: 6px; color: #00f0ff; cursor: pointer; padding: 0 12px; font: inherit; }
  .pz-todo ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .pz-todo li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; }
  .pz-todo li.done .pz-todo-text { text-decoration: line-through; color: #4a5058; }
  .pz-todo li input[type="checkbox"] { accent-color: #00f0ff; }
  .pz-todo-text { flex: 1; word-break: break-all; }
  .pz-todo-del { background: none; border: none; color: #4a5058; cursor: pointer; font: inherit; padding: 0 4px; }
  .pz-todo-del:hover { color: #ff4444; }
  .pz-todo-empty { color: #4a5058; font-size: 11px; padding: 6px 2px; }
</style>
<script>
  var PZ_KEY = 'kimi-preset-todos';
  var pzList = document.getElementById('pz-todo-list');
  var pzInput = document.getElementById('pz-todo-input');
  function pzLoad() {
    try { return JSON.parse(localStorage.getItem(PZ_KEY) || '[]'); } catch (e) { return []; }
  }
  function pzSave(items) {
    try { localStorage.setItem(PZ_KEY, JSON.stringify(items)); } catch (e) {}
  }
  function pzRender() {
    var items = pzLoad();
    pzList.innerHTML = '';
    if (items.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'pz-todo-empty';
      empty.textContent = '暂无待办';
      pzList.appendChild(empty);
      return;
    }
    items.forEach(function (item, i) {
      var li = document.createElement('li');
      if (item.done) li.className = 'done';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!item.done;
      cb.addEventListener('change', function () {
        var all = pzLoad();
        if (all[i]) { all[i].done = cb.checked; pzSave(all); }
        pzRender();
      });
      var text = document.createElement('span');
      text.className = 'pz-todo-text';
      text.textContent = item.text;
      var del = document.createElement('button');
      del.className = 'pz-todo-del';
      del.textContent = '×';
      del.addEventListener('click', function () {
        var all = pzLoad();
        all.splice(i, 1);
        pzSave(all);
        pzRender();
      });
      li.append(cb, text, del);
      pzList.appendChild(li);
    });
  }
  function pzAdd() {
    var v = pzInput.value.trim();
    if (!v) return;
    var all = pzLoad();
    all.push({ text: v, done: false });
    pzSave(all);
    pzInput.value = '';
    pzRender();
  }
  document.getElementById('pz-todo-add').addEventListener('click', pzAdd);
  pzInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') pzAdd(); });
  pzRender();
</script>
`;

const WEATHER_HTML = `
<div class="pz-wx">
  <div class="pz-wx-row">
    <input id="pz-wx-city" type="text" value="Shanghai" autocomplete="off" />
    <button id="pz-wx-go">查询</button>
  </div>
  <div class="pz-wx-now" id="pz-wx-now">载入中…</div>
  <div class="pz-wx-meta" id="pz-wx-meta"></div>
</div>
<style>
  .pz-wx { font-family: "SF Mono", Menlo, monospace; color: #dde3ea; }
  .pz-wx-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .pz-wx-row input { flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(0,240,255,0.2); border-radius: 6px; color: #dde3ea; padding: 6px 10px; font: inherit; font-size: 12px; outline: none; }
  .pz-wx-row input:focus { border-color: rgba(0,240,255,0.5); }
  .pz-wx-row button { background: rgba(0,240,255,0.1); border: 1px solid rgba(0,240,255,0.3); border-radius: 6px; color: #00f0ff; cursor: pointer; padding: 0 12px; font: inherit; font-size: 12px; }
  .pz-wx-now { font-size: 28px; color: #00f0ff; text-shadow: 0 0 14px rgba(0,240,255,0.4); margin-bottom: 6px; }
  .pz-wx-meta { font-size: 11px; color: #7d8590; line-height: 1.8; }
  .pz-wx-now.err { font-size: 12px; color: #ff4444; text-shadow: none; }
</style>
<script>
  var pzNow = document.getElementById('pz-wx-now');
  var pzMeta = document.getElementById('pz-wx-meta');
  var pzCity = document.getElementById('pz-wx-city');
  var pzTimer = 0;
  function pzFetch() {
    var city = pzCity.value.trim() || 'Shanghai';
    pzNow.className = 'pz-wx-now';
    pzNow.textContent = '载入中…';
    fetch('https://wttr.in/' + encodeURIComponent(city) + '?format=j1')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var cur = data.current_condition && data.current_condition[0];
        if (!cur) throw new Error('no data');
        var desc = (cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value) || cur.weatherDesc[0].value;
        pzNow.textContent = cur.temp_C + '°C · ' + desc;
        pzMeta.textContent = city + ' · 体感 ' + cur.FeelsLikeC + '°C · 湿度 ' + cur.humidity + '% · 风 ' + cur.windspeedKmph + ' km/h · 更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      })
      .catch(function (e) {
        pzNow.className = 'pz-wx-now err';
        pzNow.textContent = '天气获取失败：' + e.message;
        pzMeta.textContent = '';
      });
  }
  document.getElementById('pz-wx-go').addEventListener('click', function () {
    if (pzTimer) clearInterval(pzTimer);
    pzFetch();
    pzTimer = setInterval(pzFetch, 10 * 60 * 1000);
  });
  pzCity.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('pz-wx-go').click();
  });
  pzFetch();
  pzTimer = setInterval(pzFetch, 10 * 60 * 1000);
</script>
`;

export const PRESETS: PresetArtifact[] = [
  {
    id: 'preset-world-clock',
    title: '世界时钟',
    description: '多城市时间（Intl 时区），每秒刷新',
    html: WORLD_CLOCK_HTML,
  },
  {
    id: 'preset-todo',
    title: '待办清单',
    description: '本地待办（localStorage 持久化）',
    html: TODO_HTML,
  },
  {
    id: 'preset-weather',
    title: '天气',
    description: 'wttr.in 实时天气，10 分钟自动刷新',
    html: WEATHER_HTML,
  },
];
