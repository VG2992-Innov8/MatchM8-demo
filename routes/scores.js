// routes/scores.js — robust scorer (supports old & new predictions shapes)

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { DATA_DIR } = require('../lib/paths');

const router = express.Router();
router.use(express.json());

// Directories inside the active DATA_DIR (demo/prod aware)
const DATA      = DATA_DIR;
const PRED_DIR  = path.join(DATA, 'predictions');
const RES_DIR   = path.join(DATA, 'results');
const SCO_DIR   = path.join(DATA, 'scores');
const SCO_WEEKS = path.join(SCO_DIR, 'weeks'); // canonical weekly folder
const PLAYERS   = path.join(DATA, 'players.json');

/* ---------------- IO helpers ---------------- */

function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fb; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function clampInt(v, min, fb) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : fb;
}
function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/* ---------------- Normalisers ---------------- */

// results can be {id:{homeGoals,awayGoals}} or {id:{home,away}} or {id:[h,a]}
function normaliseResults(obj = {}) {
  const out = {};
  for (const [id, v] of Object.entries(obj || {})) {
    if (Array.isArray(v)) {
      out[id] = { home: Number(v[0] ?? 0), away: Number(v[1] ?? 0) };
    } else if (v && typeof v === 'object') {
      const home = 'homeGoals' in v ? v.homeGoals : ('home' in v ? v.home : null);
      const away = 'awayGoals' in v ? v.awayGoals : ('away' in v ? v.away : null);
      if (home != null && away != null) out[id] = { home: Number(home), away: Number(away) };
    }
  }
  return out;
}

// predictions may be array rows or map keyed by player_id
function normalisePredictions(data) {
  const map = new Map(); // player_id -> [{id,home,away}, ...]
  if (Array.isArray(data)) {
    for (const row of data) {
      const pid = String(row.player_id ?? '').trim();
      const arr = Array.isArray(row.predictions) ? row.predictions : [];
      if (!pid) continue;
      map.set(pid, arr.map(p => ({ id: String(p.id), home: Number(p.home ?? 0), away: Number(p.away ?? 0) })));
    }
  } else if (data && typeof data === 'object') {
    for (const [pidRaw, row] of Object.entries(data)) {
      const pid = String(pidRaw);
      const arr = Array.isArray(row?.predictions) ? row.predictions : [];
      map.set(pid, arr.map(p => ({ id: String(p.id), home: Number(p.home ?? 0), away: Number(p.away ?? 0) })));
    }
  }
  return map;
}

function outcome(h, a) {
  if (h > a) return 'H';
  if (a > h) return 'A';
  return 'D';
}

// exact = 3, correct result only = 1, else 0
function pointsFor(pred, actual) {
  if (!actual) return 0;
  if (pred.home === actual.home && pred.away === actual.away) return 3;
  return outcome(pred.home, pred.away) === outcome(actual.home, actual.away) ? 1 : 0;
}

function computeWeekTable(week, predMap, results, playersIndex) {
  const table = []; // [{player_id, name, week_points}]
  for (const [pid, arr] of predMap.entries()) {
    let pts = 0;
    for (const p of arr) {
      const actual = results[p.id];
      pts += pointsFor(p, actual);
    }
    table.push({
      player_id: pid,
      name: playersIndex.get(pid)?.name || '',
      week_points: pts
    });
  }
  table.sort((a, b) => b.week_points - a.week_points || a.name.localeCompare(b.name));
  return table;
}

/* -------- Season totals normalisation (array <-> map) -------- */

function seasonToMap(any) {
  const map = new Map(); // pid -> { player_id, player, totalPoints, weeksPlayed }
  if (Array.isArray(any)) {
    for (const row of any) {
      const pid = String(row.player_id ?? row.playerId ?? '');
      const player = String(row.player ?? row.name ?? '').trim();
      const totalPoints = Number(row.totalPoints ?? row.total ?? 0);
      const weeksPlayed = Number(row.weeksPlayed ?? row.weeks_played ?? 0);
      if (!pid && !player) continue;
      map.set(pid || player, { player_id: pid || player, player, totalPoints, weeksPlayed });
    }
  } else if (any && typeof any === 'object') {
    for (const [pid, v] of Object.entries(any)) {
      const player = String(v?.name ?? '').trim();
      const totalPoints = Number(v?.total ?? 0);
      const weeksPlayed = Number(v?.weeks_played ?? 0);
      map.set(String(pid), { player_id: String(pid), player, totalPoints, weeksPlayed });
    }
  }
  return map;
}

function seasonMapToArray(map) {
  return Array.from(map.values())
    .sort((a, b) => b.totalPoints - a.totalPoints || a.player.localeCompare(b.player));
}

/* ---------------- Rebuild season totals from weekly files (idempotent) ---------------- */

function rebuildSeasonTotalsFromWeeks() {
  // Read all week files and aggregate: totals & weeksPlayed per player
  const totals = new Map(); // pid -> { player_id, player, totalPoints, weeksPlayed }
  try {
    fs.mkdirSync(SCO_WEEKS, { recursive: true });
    const entries = fs.readdirSync(SCO_WEEKS, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/^week-\d+\.json$/i.test(ent.name)) continue;
      const weekArr = readJson(path.join(SCO_WEEKS, ent.name), []);
      const seenThisWeek = new Set(); // so a player doesn't get double-counted inside one file
      for (const row of weekArr) {
        const pid = String(row.player_id ?? '').trim();
        if (!pid) continue;
        const name = String(row.player ?? row.name ?? '').trim();
        const pts  = Number(row.weekPoints ?? row.week_points ?? row.points ?? 0);
        const cur = totals.get(pid) || { player_id: pid, player: name, totalPoints: 0, weeksPlayed: 0 };
        cur.player = name || cur.player;
        cur.totalPoints += pts;
        if (!seenThisWeek.has(pid)) { cur.weeksPlayed += 1; seenThisWeek.add(pid); }
        totals.set(pid, cur);
      }
    }
  } catch {
    // ignore — we'll still merge players below
  }

  // ⬇️ Ensure every registered player appears, even with zero totals
  const playersArr = readJson(PLAYERS, []);
  for (const p of playersArr) {
    const pid = String(p.id);
    if (!totals.has(pid)) {
      totals.set(pid, { player_id: pid, player: p.name || '', totalPoints: 0, weeksPlayed: 0 });
    }
  }

  return seasonMapToArray(totals);
}

/* ---------------- Core compute (shared) ---------------- */

function computeAndPersist(week) {
  const predsRaw   = readJson(path.join(PRED_DIR, `week-${week}.json`), null);
  const resultsRaw = readJson(path.join(RES_DIR,  `week-${week}.json`), null);

  const predMap  = normalisePredictions(predsRaw);
  const results  = normaliseResults(resultsRaw);

  const playersArr = readJson(PLAYERS, []);
  const playersIdx = new Map(playersArr.map(p => [String(p.id), { name: p.name || '' }]));

  const weekTable = computeWeekTable(week, predMap, results, playersIdx);

  // Persist weekly scores (canonical + legacy path)
  const weeklyOut = weekTable.map(r => ({
    player_id: r.player_id,
    player: r.name,
    weekPoints: r.week_points
  }));
  writeJson(path.join(SCO_WEEKS, `week-${week}.json`), weeklyOut);
  writeJson(path.join(SCO_DIR,    `week-${week}.json`), weeklyOut); // legacy

  // *** Rebuild season totals from all week files (idempotent) ***
  const seasonTotalsArr = rebuildSeasonTotalsFromWeeks();
  writeJson(path.join(SCO_DIR, 'season-totals.json'), seasonTotalsArr);

  // Legacy map (optional; keeps old consumers happy)
  const legacy = {};
  for (const t of seasonTotalsArr) {
    legacy[t.player_id] = { name: t.player, total: t.totalPoints, weeks_played: t.weeksPlayed };
  }
  writeJson(path.join(SCO_DIR, 'season-totals.legacy.json'), legacy);

  // Include season total for each weekly row in response
  const totalsMap = new Map(seasonTotalsArr.map(t => [t.player_id, t]));
  const weeklyWithSeason = weeklyOut.map(r => {
    const tot = totalsMap.get(r.player_id);
    return { ...r, seasonTotal: tot ? tot.totalPoints : r.weekPoints };
  });

  return {
    week,
    saved: weeklyOut.length,
    weekly: weeklyWithSeason,
    seasonTotals: seasonTotalsArr
  };
}

/* ---------------- Endpoints ---------------- */

// Preview (no writes)
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  const week = clampInt(req.query.week, 1, null);
  if (!week) return res.status(400).json({ ok: false, error: 'week required' });

  const predsRaw   = readJson(path.join(PRED_DIR, `week-${week}.json`), null);
  const resultsRaw = readJson(path.join(RES_DIR,  `week-${week}.json`), null);

  const predMap  = normalisePredictions(predsRaw);
  const results  = normaliseResults(resultsRaw);

  const playersArr = readJson(PLAYERS, []);
  const playersIdx = new Map(playersArr.map(p => [String(p.id), { name: p.name || '' }]));

  const table = computeWeekTable(week, predMap, results, playersIdx);

  return res.json({
    ok: true,
    week,
    fixturesCount: Object.keys(results).length,
    playerCount: predMap.size,
    scores: table
  });
});

// Compute & persist (POST)
router.post('/compute', (req, res) => {
  const week = clampInt(req.body?.week, 1, null);
  if (!week) return res.status(400).json({ ok: false, error: 'week required' });

  const payload = computeAndPersist(week);
  return res.json({ ok: true, ...payload });
});

// Compute & persist (GET fallback for compatibility: /api/scores/compute?week=N)
router.get('/compute', (req, res) => {
  const week = clampInt(req.query?.week, 1, null);
  if (!week) return res.status(400).json({ ok: false, error: 'week required' });

  const payload = computeAndPersist(week);
  return res.json({ ok: true, ...payload });
});

// Summary — reads from disk; rebuilds missing totals; computes weekly on the fly if missing
router.get('/summary', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  try {
    const week = clampInt(req.query.week, 1, null);

    // Season totals: read or rebuild (and persist) if missing
    let seasonTotals = readJson(path.join(SCO_DIR, 'season-totals.json'), null);
    if (!Array.isArray(seasonTotals)) {
      seasonTotals = rebuildSeasonTotalsFromWeeks();
      writeJson(path.join(SCO_DIR, 'season-totals.json'), seasonTotals);
      const legacy = {};
      for (const t of seasonTotals) legacy[t.player_id] = { name: t.player, total: t.totalPoints, weeks_played: t.weeksPlayed };
      writeJson(path.join(SCO_DIR, 'season-totals.legacy.json'), legacy);
    } else {
      // normalise shape if a legacy map slipped in
      seasonTotals = seasonMapToArray(seasonToMap(seasonTotals));
    }

    // Weekly: prefer saved file; if missing, compute on the fly (no write)
    let weekly = null;
    if (week != null) {
      weekly = readJson(path.join(SCO_WEEKS, `week-${week}.json`), null);
      if (!Array.isArray(weekly)) {
        const predsRaw   = readJson(path.join(PRED_DIR, `week-${week}.json`), null);
        const resultsRaw = readJson(path.join(RES_DIR,  `week-${week}.json`), null);
        const predMap    = normalisePredictions(predsRaw);
        const results    = normaliseResults(resultsRaw);
        const playersArr = readJson(PLAYERS, []);
        const playersIdx = new Map(playersArr.map(p => [String(p.id), { name: p.name || '' }]));
        const table      = computeWeekTable(week, predMap, results, playersIdx);
        weekly = table.map(r => ({ player_id: r.player_id, player: r.name, weekPoints: r.week_points }));
      }
    }

    const stat = safeStat(path.join(SCO_DIR, 'season-totals.json'));
    return res.json({
      ok: true,
      week,
      updatedAtISO: stat?.mtime ? new Date(stat.mtime).toISOString() : null,
      seasonTotals,
      weekly
    });
  } catch (e) {
    console.error('summary_failed', e);
    res.status(500).json({ ok: false, error: 'summary_failed' });
  }
});

// ---- Player week breakdown: predictions + results + per-match points

function readConfig() {
  const cfgPath = path.join(DATA, 'config.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { season: 2025 };
  }
}

function normaliseFixtures(any) {
  const out = new Map();
  if (Array.isArray(any)) {
    for (const m of any) {
      const id = String(m.id ?? m.matchId ?? m.code ?? out.size + 1);
      const home = m.home?.name ?? m.home ?? m.homeTeam ?? m.home_team ?? m.homeTeamName ?? 'Home';
      const away = m.away?.name ?? m.away ?? m.awayTeam ?? m.away_team ?? m.awayTeamName ?? 'Away';
      const ko   = m.kickoffISO ?? m.kickoff_iso ?? m.kickoff ?? m.utcDate ?? null;
      out.set(id, { id, homeTeam: String(home), awayTeam: String(away), kickoffISO: ko });
    }
  } else if (any && typeof any === 'object') {
    for (const [idRaw, m] of Object.entries(any)) {
      const id = String(idRaw);
      const home = m.home?.name ?? m.home ?? m.homeTeam ?? m.home_team ?? m.homeTeamName ?? 'Home';
      const away = m.away?.name ?? m.away ?? m.awayTeam ?? m.away_team ?? m.awayTeamName ?? 'Away';
      const ko   = m.kickoffISO ?? m.kickoff_iso ?? m.kickoff ?? m.utcDate ?? null;
      out.set(id, { id, homeTeam: String(home), awayTeam: String(away), kickoffISO: ko });
    }
  }
  return out;
}

function findPlayerByName(playersArr, name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return playersArr.find(p => String(p.name || '').trim().toLowerCase() === n) || null;
}

router.get('/player-week', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  const week = clampInt(req.query.week, 1, null);
  if (!week) return res.status(400).json({ ok: false, error: 'week required' });

  const playersArr = readJson(PLAYERS, []);
  let playerId = (req.query.player_id || req.query.playerId || '').toString().trim();
  let playerName = (req.query.name || req.query.player || '').toString().trim();

  if (!playerId && playerName) {
    const hit = findPlayerByName(playersArr, playerName);
    if (hit) playerId = String(hit.id), playerName = hit.name;
  }
  if (!playerId) return res.status(400).json({ ok: false, error: 'player_id or name required' });

  const cfg = readConfig();
  const fxBase = path.join(DATA, 'fixtures', `season-${cfg.season || 2025}`);
  const fixturesRaw =
      readJson(path.join(fxBase, `week-${week}.json`), null)
   ?? readJson(path.join(fxBase, 'weeks', `week-${week}.json`), null);

  const predsRaw   = readJson(path.join(PRED_DIR, `week-${week}.json`), null);
  const resultsRaw = readJson(path.join(RES_DIR,  `week-${week}.json`), null);

  const predMap  = normalisePredictions(predsRaw);
  const results  = normaliseResults(resultsRaw);
  const fixtures = normaliseFixtures(fixturesRaw);

  const playerPreds = new Map((predMap.get(playerId) || []).map(p => [String(p.id), p]));

  let weekPoints = 0, exactCount = 0, outcomeCount = 0, pendingCount = 0, missedCount = 0;

  const rows = [];
  const ids = fixtures.size ? Array.from(fixtures.keys()) : Array.from(new Set([
    ...Object.keys(results), ...Array.from(playerPreds.keys())
  ]));

  for (const id of ids) {
    const fx = fixtures.get(id) || { id, homeTeam: 'Home', awayTeam: 'Away', kickoffISO: null };
    const pred = playerPreds.get(id) || null;
    const actual = results[id] || null;

    let pts = null;
    if (actual && pred) {
      pts = pointsFor(pred, actual);
      weekPoints += pts;
      if (pts === 3) exactCount++;
      else if (pts === 1) outcomeCount++;
    } else if (!actual) {
      pendingCount++;
    } else if (actual && !pred) {
      missedCount++;
    }

    rows.push({
      matchId: id,
      homeTeam: fx.homeTeam,
      awayTeam: fx.awayTeam,
      kickoffISO: fx.kickoffISO,
      prediction: pred ? { home: pred.home, away: pred.away } : null,
      result: actual ? { home: actual.home, away: actual.away } : null,
      points: pts
    });
  }

  const player = playersArr.find(p => String(p.id) === String(playerId)) || { id: playerId, name: playerName || '' };

  return res.json({
    ok: true,
    week,
    player: { id: String(player.id), name: player.name || playerName || '' },
    rows,
    totals: { weekPoints, exactCount, outcomeCount, pendingCount, missedCount }
  });
});

/* ---------- Weekly Matrix (per-week points + season total) ---------- */
// GET /api/scores/leaderboard/matrix?window=5&endWeek=auto
router.get('/leaderboard/matrix', async (req, res) => {
  try {
    const WEEKS_DIR  = path.join(SCO_DIR, 'weeks');

    // list available week-N.json files
    const files = await fsp.readdir(WEEKS_DIR).catch(() => []);
    const weekNums = files
      .map(f => (f.match(/^week-(\d+)\.json$/) || [])[1])
      .filter(Boolean)
      .map(n => parseInt(n, 10))
      .sort((a, b) => a - b);

    if (weekNums.length === 0) {
      return res.json({ weeks: [], rows: [] });
    }

    const window   = Math.max(1, Math.min(parseInt(req.query.window, 10) || 5, 38));
    const endWeek  = req.query.endWeek ? parseInt(req.query.endWeek, 10) : weekNums[weekNums.length - 1];
    const startWeek = Math.max(1, endWeek - window + 1);
    const selectedWeeks = weekNums.filter(w => w >= startWeek && w <= endWeek);

    // read a week file and normalise shape
    async function readWeek(w) {
      const p = path.join(WEEKS_DIR, `week-${w}.json`);
      const json = JSON.parse(await fsp.readFile(p, 'utf8'));

      const mapRow = (r) => ({
        player_id: r.player_id ?? r.id ?? r.player ?? r.name,
        name:      r.name ?? String(r.player ?? r.player_id ?? r.id),
        points:    Number(r.weekPoints ?? r.points ?? r.total ?? r.score ?? 0),
      });

      if (Array.isArray(json)) return json.map(mapRow);
      if (Array.isArray(json.players)) return json.players.map(mapRow);
      if (Array.isArray(json.scores))  return json.scores.map(mapRow);
      return [];
    }

    // build player maps
    const players = new Map();      // id -> name
    const perWeek = new Map();      // id -> { [week]: pts }

    for (const w of selectedWeeks) {
      const rows = await readWeek(w);
      for (const r of rows) {
        const id = String(r.player_id ?? r.name);
        players.set(id, r.name ?? id);
        if (!perWeek.has(id)) perWeek.set(id, {});
        perWeek.get(id)[w] = r.points || 0;
      }
    }

    // totals up to endWeek (season-to-date)
    const totalsToDate = new Map();
    for (const id of players.keys()) {
      let total = 0;
      for (const w of weekNums) {
        if (w > endWeek) break;
        total += perWeek.get(id)?.[w] ?? 0;
      }
      totalsToDate.set(id, total);
    }

    // rows + rank
    const rows = [...players.keys()].map(id => ({
      player_id: id,
      name: players.get(id),
      weekly: Object.fromEntries(selectedWeeks.map(w => [w, perWeek.get(id)?.[w] ?? 0])),
      total: totalsToDate.get(id) || 0,
    }));

    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    let last = null, rank = 0, seen = 0;
    for (const r of rows) {
      seen += 1;
      if (r.total !== last) { rank = seen; last = r.total; }
      r.rank = rank;
    }

    res.json({ startWeek, endWeek, weeks: selectedWeeks, rows });
  } catch (err) {
    console.error('leaderboard/matrix error', err);
    res.status(500).json({ error: 'leaderboard matrix failed', details: String(err) });
  }
});

module.exports = router;
