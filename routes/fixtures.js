// routes/fixtures.js — robust fixtures API (query or param), no 404s

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { DATA_DIR } = require('../lib/paths');

// Keep defaults aligned with index.js
const DEFAULT_CONFIG = {
  season: 2025,
  total_weeks: 38,
  current_week: 1,
  lock_minutes_before_kickoff: 10,
  deadline_mode: 'first_kickoff',
  timezone: 'Australia/Melbourne',
};

function readConfig() {
  const cfgPath = path.join(DATA_DIR, 'config.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const obj = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...obj };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function readFixturesForWeek(season, week) {
  // Support both layouts:
  //   /fixtures/season-YYYY/week-N.json
  //   /fixtures/season-YYYY/weeks/week-N.json
  const base = path.join(DATA_DIR, 'fixtures', `season-${season}`);
  const candidates = [
    path.join(base, `week-${week}.json`),
    path.join(base, 'weeks', `week-${week}.json`),
  ];

  for (const p of candidates) {
    try {
      const txt = await fsp.readFile(p, 'utf8');
      const json = JSON.parse(txt);
      if (Array.isArray(json)) return json;
      if (json && Array.isArray(json.fixtures)) return json.fixtures;
      // Unexpected shape — return empty but don't throw
      return [];
    } catch {
      // try next candidate
    }
  }
  return []; // not found -> return empty (200), never 404
}

// GET /api/fixtures?week=3[&season=2025]
router.get('/', async (req, res) => {
  const cfg = readConfig();
  const season = parseInt(req.query.season, 10) || cfg.season || DEFAULT_CONFIG.season;
  const week = Math.max(1, parseInt(req.query.week, 10) || cfg.current_week || 1);
  const data = await readFixturesForWeek(season, week);
  return res.json(data);
});

// GET /api/fixtures/3  (optional season override via ?season=2025)
router.get('/:week', async (req, res) => {
  const cfg = readConfig();
  const season = parseInt(req.query.season, 10) || cfg.season || DEFAULT_CONFIG.season;
  const week = Math.max(1, parseInt(req.params.week, 10) || cfg.current_week || 1);
  const data = await readFixturesForWeek(season, week);
  return res.json(data);
});

module.exports = router;
