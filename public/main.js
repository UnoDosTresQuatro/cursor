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

// Legend stats helpers
let currentLegendStats = {};
function formatStatNumber(value) {
  if (value == null || Number.isNaN(value)) return 'N/A';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(3);
}
function computeLegendStats(seriesList) {
  const stats = {};
  for (const s of seriesList) {
    const data = Array.isArray(s.data) ? s.data : [];
    let count = 0;
    let sum = 0;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < data.length; i += 1) {
      const y = Array.isArray(data[i]) ? Number(data[i][1]) : Number(data[i]);
      if (Number.isFinite(y)) {
        count += 1;
        sum += y;
        if (y > max) max = y;
      }
    }
    let last = null;
    for (let i = data.length - 1; i >= 0; i -= 1) {
      const y = Array.isArray(data[i]) ? Number(data[i][1]) : Number(data[i]);
      if (Number.isFinite(y)) { last = y; break; }
    }
    stats[s.name] = {
      mean: count > 0 ? (sum / count) : null,
      max: count > 0 ? max : null,
      last: last,
    };
  }
  return stats;
}

// Grafana-like classic color palette
const grafanaPalette = [
  '#7EB26D', '#EAB839', '#6ED0E0', '#EF843C', '#E24D42', '#1F78C1', '#BA43A9', '#705DA0',
  '#508642', '#CCA300', '#447EBC', '#C15C17', '#890F02', '#0A437C', '#6D1F62', '#584477',
  '#B7DBAB', '#F4D598', '#70DBED', '#F9BA8F', '#F29191', '#82B5D8', '#E5A8E2', '#AEA2E0'
];

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
  currentLegendStats = computeLegendStats(seriesList);
  const option = {
    title: { text: title },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    grid: { left: 48, right: 24, top: 48, bottom: 48 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', scale: true },
    legend: {
      type: 'scroll',
      formatter: function(name) {
        const s = currentLegendStats && currentLegendStats[name];
        if (!s) return name;
        return `${name}  [last=${formatStatNumber(s.last)}  max=${formatStatNumber(s.max)}  mean=${formatStatNumber(s.mean)}]`;
      }
    },
    series: seriesList,
  };
  const c = ensureChart();
  if (c) c.setOption(option);
}

// Add: download current chart image
const downloadBtn = document.getElementById('downloadBtn');
function downloadChart(format = 'png') {
  const c = ensureChart();
  if (!c) return;
  const dataURL = c.getDataURL({
    type: format,
    pixelRatio: 2,
    backgroundColor: '#ffffff',
    excludeComponents: [],
  });
  const link = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = dataURL;
  link.download = `chart-${ts}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
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
    const tMillis = typeof time === 'number' ? time : Date.parse(time);

    if (row.value != null && String(row.status) !== "all") {
      const seriesName = String(`{host=${row.host},request=${row.request},status=${row.status}}`);
      const value = Number(row.value);
      if (!groups.has(seriesName)) groups.set(seriesName, []);
      groups.get(seriesName).push([tMillis, value]);
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
    queryLabel.title = queryLabel.textContent;
    if (!queryInput.value || queryInput.value.trim().toLowerCase() === 'select 1') {
      queryInput.value = 'up';
    }
    stepInput.disabled = false;
  } else {
    queryLabel.textContent = 'ClickHouse SQL';
    queryLabel.title = queryLabel.textContent;
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


sourceSelect.addEventListener('change', updateUiForSource);
sourceSelect.addEventListener('input', updateUiForSource);
rangeSelect.addEventListener('change', updateTimeRow);
runBtn.addEventListener('click', async () => {
  await run();
  setupAutoRefresh();
});

if (downloadBtn) {
  downloadBtn.addEventListener('click', () => downloadChart('png'));
}

refreshInput.addEventListener('change', setupAutoRefresh);

// Initial UI setup
updateUiForSource();
updateTimeRow();
setNowRange('1h');
run();