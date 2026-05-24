const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// Postgres connection (Supabase). DATABASE_URL is set as an environment
// variable in Render — never hard-coded here.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Admin key for export access. Set ADMIN_KEY in Render's environment.
const ADMIN_KEY = process.env.ADMIN_KEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Create the table if it doesn't already exist (safe to run every boot).
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        category TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        story TEXT NOT NULL,
        public_name BOOLEAN DEFAULT true,
        story_expenses TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        ip_hash TEXT
      )
    `);
    console.log('Database ready');
  } catch (err) {
    console.error('Table init error:', err);
  }
}

function hashIP(ip) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
}

// GET all stories + stats
app.get('/api/stories', async (req, res) => {
  const filter = req.query.category || 'All';
  try {
    const result = await pool.query(
      'SELECT id, name, address, category, amount, story, public_name, story_expenses, timestamp FROM stories ORDER BY timestamp DESC'
    );
    const rows = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      address: r.address,
      category: r.category,
      amount: parseFloat(r.amount),
      story: r.story,
      publicName: r.public_name,
      story_expenses: r.story_expenses,
      timestamp: r.timestamp
    }));

    let filtered = rows;
    if (filter !== 'All') {
      filtered = rows.filter(r => r.category === filter);
    }

    const totalCost = rows.reduce((sum, r) => sum + r.amount, 0);
    const avgCost = rows.length > 0 ? totalCost / rows.length : 0;

    res.json({
      stories: filtered,
      stats: {
        totalResidents: rows.length,
        totalCost: Math.round(totalCost * 100) / 100,
        averageCost: Math.round(avgCost * 100) / 100,
        categories: [...new Set(rows.map(r => r.category))]
      }
    });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST a new story
app.post('/api/stories', async (req, res) => {
  const { name, address, category, amount, story, publicName, story_expenses } = req.body;

  if (!name || !address || !category || amount === undefined || !story) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (isNaN(parseFloat(amount)) || parseFloat(amount) < 0 || parseFloat(amount) > 100000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (story.length < 10 || story.length > 5000) {
    return res.status(400).json({ error: 'Story must be 10-5000 characters' });
  }

  const ipHash = hashIP(req.ip);

  try {
    // Spam guard: max 5 submissions per IP per 24h
    const recent = await pool.query(
      "SELECT COUNT(*) AS count FROM stories WHERE ip_hash = $1 AND timestamp > NOW() - INTERVAL '24 hours'",
      [ipHash]
    );
    if (parseInt(recent.rows[0].count, 10) >= 5) {
      return res.status(429).json({ error: 'Too many submissions from this location. Please try again later.' });
    }

    const result = await pool.query(
      'INSERT INTO stories (name, address, category, amount, story, public_name, story_expenses, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, address, category, parseFloat(amount), story, publicName ? true : false, story_expenses || '[]', ipHash]
    );

    res.json({ success: true, id: result.rows[0].id, message: 'Your story has been posted' });
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Failed to save story' });
  }
});

// --- ADMIN-ONLY EXPORTS (require ?key=ADMIN_KEY) ---
function checkAdmin(req, res) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

app.get('/api/export/json', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const result = await pool.query(
      'SELECT name, address, category, amount, story, public_name, story_expenses, timestamp FROM stories ORDER BY timestamp DESC'
    );
    const data = {
      exportDate: new Date().toISOString(),
      totalStories: result.rows.length,
      totalCost: result.rows.reduce((s, r) => s + parseFloat(r.amount), 0),
      stories: result.rows.map(r => {
        let expenses = [];
        try { expenses = JSON.parse(r.story_expenses || '[]'); } catch (e) { expenses = []; }
        return {
          name: r.public_name ? r.name : 'Anonymous',
          address: r.address,
          category: r.category,
          amount: parseFloat(r.amount),
          expenses,
          story: r.story,
          date: new Date(r.timestamp).toLocaleDateString()
        };
      })
    };
    res.header('Content-Type', 'application/json');
    res.header('Content-Disposition', 'attachment; filename="gg-evacuation-claims.json"');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

app.get('/api/export/csv', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const result = await pool.query(
      'SELECT name, address, category, amount, story, public_name, story_expenses, timestamp FROM stories ORDER BY timestamp DESC'
    );
    const esc = (v) => {
      const s = String(v == null ? '' : v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const header = ['name', 'address', 'category', 'amount', 'expenses', 'story', 'date'];
    const lines = [header.join(',')];
    for (const r of result.rows) {
      let expenses = [];
      try { expenses = JSON.parse(r.story_expenses || '[]'); } catch (e) { expenses = []; }
      const breakdown = expenses.map(x => `${x.category}: $${x.amount}`).join('; ');
      lines.push([
        esc(r.public_name ? r.name : 'Anonymous'),
        esc(r.address),
        esc(r.category),
        esc(r.amount),
        esc(breakdown),
        esc(r.story),
        esc(new Date(r.timestamp).toLocaleDateString())
      ].join(','));
    }
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', 'attachment; filename="gg-evacuation-claims.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
