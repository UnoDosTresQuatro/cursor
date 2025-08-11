// Minimal Express server that serves static assets and proxies Prometheus and ClickHouse

const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Env config
const PROMETHEUS_BASE_URL = process.env.PROMETHEUS_BASE_URL || '';
const PROMETHEUS_BEARER = process.env.PROMETHEUS_BEARER || '';
const PROMETHEUS_BASIC_USER = process.env.PROMETHEUS_BASIC_USER || '';
const PROMETHEUS_BASIC_PASS = process.env.PROMETHEUS_BASIC_PASS || '';

const CLICKHOUSE_BASE_URL = process.env.CLICKHOUSE_BASE_URL || '';
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || '';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const CLICKHOUSE_BEARER = process.env.CLICKHOUSE_BEARER || '';

// Helpers
function buildPrometheusHeaders() {
  const headers = {};
  if (PROMETHEUS_BEARER) {
    headers['Authorization'] = `Bearer ${PROMETHEUS_BEARER}`;
  } else if (PROMETHEUS_BASIC_USER && PROMETHEUS_BASIC_PASS) {
    const token = Buffer.from(`${PROMETHEUS_BASIC_USER}:${PROMETHEUS_BASIC_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  return headers;
}

function buildClickHouseHeaders() {
  const headers = {};
  if (CLICKHOUSE_BEARER) {
    headers['Authorization'] = `Bearer ${CLICKHOUSE_BEARER}`;
  } else if (CLICKHOUSE_USER && CLICKHOUSE_PASSWORD) {
    const token = Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  return headers;
}

// Prometheus proxies
app.get('/api/prometheus/query_range', async (req, res) => {
  try {
    if (!PROMETHEUS_BASE_URL) {
      return res.status(500).json({ error: 'PROMETHEUS_BASE_URL is not configured' });
    }
    const url = new URL('/api/v1/query_range', PROMETHEUS_BASE_URL).toString();
    const headers = buildPrometheusHeaders();

    const response = await axios.get(url, {
      headers,
      params: req.query,
      timeout: 30000,
    });
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({
      error: 'Prometheus query_range failed',
      details: error.response?.data || error.message,
    });
  }
});

app.get('/api/prometheus/query', async (req, res) => {
  try {
    if (!PROMETHEUS_BASE_URL) {
      return res.status(500).json({ error: 'PROMETHEUS_BASE_URL is not configured' });
    }
    const url = new URL('/api/v1/query', PROMETHEUS_BASE_URL).toString();
    const headers = buildPrometheusHeaders();

    const response = await axios.get(url, {
      headers,
      params: req.query,
      timeout: 30000,
    });
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({
      error: 'Prometheus query failed',
      details: error.response?.data || error.message,
    });
  }
});

// ClickHouse proxy
// Accepts JSON body: { sql: string }
app.post('/api/clickhouse/query', async (req, res) => {
  try {
    if (!CLICKHOUSE_BASE_URL) {
      return res.status(500).json({ error: 'CLICKHOUSE_BASE_URL is not configured' });
    }

    const sqlRaw = req.body?.sql || '';
    if (!sqlRaw) {
      return res.status(400).json({ error: 'Missing sql in request body' });
    }

    // Ensure FORMAT JSON at the end for structured results
    const sql = /\bformat\s+json\b/i.test(sqlRaw) ? sqlRaw : `${sqlRaw.trim()}\nFORMAT JSON`;

    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      ...buildClickHouseHeaders(),
    };

    // ClickHouse expects the SQL in the request body to the base URL
    const response = await axios.post(CLICKHOUSE_BASE_URL, sql, {
      headers,
      timeout: 60000,
    });

    // Pass through JSON from ClickHouse
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({
      error: 'ClickHouse query failed',
      details: error.response?.data || error.message,
    });
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});