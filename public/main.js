/* Frontend logic: query Prometheus or ClickHouse via backend proxies and render with ECharts */

const sourceSelect = document.getElementById('sourceSelect');
const rangeSelect = document.getElementById('rangeSelect');
const stepInput = document.getElementById('stepInput');
const refreshInput = document.getElementById('refreshInput');
const runBtn = document.getElementById('runBtn');
const startInput = document.getElementById('startInput');
const endInput = document.getElementById('endInput');
const timeRow = document.getElementById('timeRow');
const queryLabel = document.getElementById('queryLabel');
const queryInput = document.getElementById('queryInput');

let refreshTimer = null;

// Default values
queryInput.value = 'up';

const chartEl = document.getElementById('chart');
let chart = null;
function ensureChart() {
  if (!chart && window.echarts) {
    chart = echarts.init(chartEl);
    window.addEventListener('resize', () => chart && chart.resize());
  }
  return chart;
}

function setNowRange(preset) {
  const now = new Date();
  let start = new Date(now);
  const map = {
    '1h': 3600,
    '6h': 6 * 3600,
    '24h': 24 * 3600,
    '2d': 2 * 24 * 3600,
    '7d': 7 * 24 * 3600,
  };
  const seconds = map[preset] || 3600;
  start.setSeconds(start.getSeconds() - seconds);
  setDateTimeLocal(startInput, start);
  setDateTimeLocal(endInput, now);
}

function setDateTimeLocal(input, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  input.value = `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
}

function toUnixSeconds(input) {
  const value = input.value;
  if (!value) return null;
  return Math.floor(new Date(value).getTime() / 1000);
}

function toUnixMillis(input) {
  const value = input.value;
  if (!value) return null;
  return new Date(value).getTime();
}

function labelFromMetric(metricObj) {
  const entries = Object.entries(metricObj || {});
  if (entries.length === 0) return 'value';
  const namePair = entries.find(([k]) => k === '__name__');
  const base = namePair ? namePair[1] : 'series';
  const labels = entries
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return labels ? `${base}{${labels}}` : base;
}

function renderSeries(seriesList, title = '') {
  const option = {
    title: { text: title },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    grid: { left: 48, right: 24, top: 48, bottom: 48 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', scale: true },
    legend: { type: 'scroll' },
    series: seriesList,
  };
  const c = ensureChart();
  if (c) c.setOption(option);
}

async function runPrometheus() {
  const query = queryInput.value.trim();
  if (!query) return;

  const isCustom = rangeSelect.value === 'custom';
  if (!isCustom) setNowRange(rangeSelect.value);
  const start = toUnixSeconds(startInput);
  const end = toUnixSeconds(endInput);
  const step = Math.max(1, Number(stepInput.value || 15));

  const params = new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) });
  const res = await fetch(`/api/prometheus/query_range?${params.toString()}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || 'Prometheus error');

  const result = json?.data?.result || [];
  const series = result.map((r) => {
    const name = labelFromMetric(r.metric);
    const data = (r.values || []).map(([ts, val]) => [Number(ts) * 1000, parseFloat(val)]);
    return { name, type: 'line', showSymbol: false, data };
  });

  renderSeries(series, query);
}

function groupRowsBySeries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const time = row.t ?? row.time ?? row.ts ?? row.timestamp;
    if (time == null) continue;
    const tMillis = typeof time === 'number' ? time : Number(time);

    const entries = Object.entries(row);

    if (row.series != null && row.value != null) {
      const seriesName = String(row.series);
      const value = Number(row.value);
      if (!groups.has(seriesName)) groups.set(seriesName, []);
      groups.get(seriesName).push([tMillis, value]);
      continue;
    }

    const scalarKeys = entries
      .filter(([k, v]) => k !== 't' && k !== 'time' && k !== 'ts' && k !== 'timestamp' && typeof v === 'number')
      .map(([k]) => k);

    if (scalarKeys.length === 0) {
      const value = Number(row.value ?? row.v ?? 0);
      const name = String(row.name ?? 'value');
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push([tMillis, value]);
    } else {
      for (const key of scalarKeys) {
        const value = Number(row[key]);
        const seriesName = String(key);
        if (!groups.has(seriesName)) groups.set(seriesName, []);
        groups.get(seriesName).push([tMillis, value]);
      }
    }
  }
  return Array.from(groups.entries()).map(([name, data]) => ({ name, data: data.sort((a,b)=>a[0]-b[0]) }));
}

async function runClickHouse() {
  const sql = queryInput.value.trim();
  if (!sql) return;

  const isCustom = rangeSelect.value === 'custom';
  if (!isCustom) setNowRange(rangeSelect.value);
  const startMs = toUnixMillis(startInput);
  const endMs = toUnixMillis(endInput);

  // Replace {{start}}/{{end}} if present (milliseconds since epoch)
  const sqlBound = sql
    .replaceAll('{{start}}', String(startMs))
    .replaceAll('{{end}}', String(endMs));

  const res = await fetch('/api/clickhouse/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: sqlBound }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || 'ClickHouse error');

  const rows = Array.isArray(json) ? json : json?.data || [];
  const grouped = groupRowsBySeries(rows);
  const series = grouped.map((g) => ({ name: g.name, type: 'line', showSymbol: false, data: g.data }));

  renderSeries(series, 'ClickHouse');
}

function updateUiForSource() {
  if (sourceSelect.value === 'prometheus') {
    queryLabel.textContent = 'PromQL';
    if (!queryInput.value || queryInput.value.trim().toLowerCase() === 'select 1') {
      queryInput.value = 'up';
    }
    stepInput.disabled = false;
  } else {
    queryLabel.textContent = 'ClickHouse SQL';
    if (!queryInput.value || queryInput.value.trim().toLowerCase() === 'up') {
      queryInput.value = `-- Example: rows with columns t (ms), value, series\nSELECT\n  toUnixTimestamp64Milli(ts) AS t,\n  value,\n  'seriesA' AS series\nFROM some_metrics\nWHERE ts BETWEEN toDateTime64({{start}}/1000, 3) AND toDateTime64({{end}}/1000, 3)\nORDER BY ts`;
    }
    stepInput.disabled = true;
  }
}

function updateTimeRow() {
  timeRow.style.display = rangeSelect.value === 'custom' ? 'flex' : 'none';
  if (rangeSelect.value !== 'custom') setNowRange(rangeSelect.value);
}

async function run() {
  try {
    if (sourceSelect.value === 'prometheus') {
      await runPrometheus();
    } else {
      await runClickHouse();
    }
  } catch (err) {
    renderSeries([], 'Error');
    console.error(err);
    const msg = (err && err.message) ? err.message : String(err);
    const c = ensureChart();
    if (c) c.setOption({ title: { text: `Error: ${msg}` } });
  }
}

function setupAutoRefresh() {
  const seconds = Number(refreshInput.value || 0);
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (seconds > 0) {
    refreshTimer = setInterval(run, seconds * 1000);
  }
}

// Event listeners
function interceptSelectProgrammaticChanges(select, onChange) {
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  try {
    Object.defineProperty(select, 'value', {
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); onChange(); },
      configurable: true,
    });
    Object.defineProperty(select, 'selectedIndex', {
      get() { return indexDesc.get.call(this); },
      set(v) { indexDesc.set.call(this, v); onChange(); },
      configurable: true,
    });
  } catch {}
}
interceptSelectProgrammaticChanges(sourceSelect, updateUiForSource);

sourceSelect.addEventListener('change', updateUiForSource);
sourceSelect.addEventListener('input', updateUiForSource);
rangeSelect.addEventListener('change', updateTimeRow);
runBtn.addEventListener('click', async () => {
  await run();
  setupAutoRefresh();
});

refreshInput.addEventListener('change', setupAutoRefresh);

// Initial UI setup
updateUiForSource();
updateTimeRow();
setNowRange('1h');
run();