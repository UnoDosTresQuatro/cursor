# ECharts Metrics Viewer

A tiny web app to visualize Prometheus or ClickHouse time-series with Apache ECharts.

## Quickstart

1. Copy env and configure endpoints:

```bash
cp .env.example .env
# Edit .env to set PROMETHEUS_BASE_URL and/or CLICKHOUSE_BASE_URL
```

2. Install and run:

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Prometheus

- Use PromQL in the query box (e.g., `up`, `rate(http_requests_total[5m])`).
- Choose a range and step.
- The app calls `/api/prometheus/query_range` and renders each time series as a separate line.

## ClickHouse

- Write SQL that returns JSON rows. The server appends `FORMAT JSON` automatically if missing.
- Expected row shapes (any of):
  - Columns: `t` (milliseconds since epoch), `value` (number), `series` (string)
  - Columns: `t` and one or more numeric columns (each numeric column becomes a series)
  - Columns: `t`, `value` and optional `name`
- You can reference the selected time range in SQL using placeholders `{{start}}` and `{{end}}` (milliseconds since epoch). Example:

```sql
SELECT
  toUnixTimestamp64Milli(ts) AS t,
  avg(value) AS value,
  'my_series' AS series
FROM some_metrics
WHERE ts BETWEEN toDateTime64({{start}}/1000, 3) AND toDateTime64({{end}}/1000, 3)
GROUP BY t
ORDER BY t
```

## Configuration

- Prometheus
  - `PROMETHEUS_BASE_URL` (e.g., `http://localhost:9090`)
  - Optional auth: `PROMETHEUS_BEARER` or `PROMETHEUS_BASIC_USER` + `PROMETHEUS_BASIC_PASS`
- ClickHouse
  - `CLICKHOUSE_BASE_URL` (e.g., `http://localhost:8123`)
  - Optional auth: `CLICKHOUSE_USER` + `CLICKHOUSE_PASSWORD` or `CLICKHOUSE_BEARER`

## Notes

- The server proxies Prometheus and ClickHouse to avoid CORS and keep credentials server-side.
- Auto-refresh can be enabled by setting the refresh interval (seconds).
