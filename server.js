const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { Parser } = require('json2csv');

const app = express();
const dbPath = path.join(__dirname, 'evacuation.db');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      story TEXT NOT NULL,
      publicName INTEGER DEFAULT 1,
      story_expenses TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ipHash TEXT
    )
  `, (err) => {
    if (err) console.error('Table creation error:', err);
    else console.log('Database ready');
  });
}

function hashIP(ip) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
}

app.get('/api/stories', (req, res) => {
  const filter = req.query.category || 'All';
  
  let query = 'SELECT id, name, address, category, amount, story, publicName, story_expenses, timestamp FROM stories ORDER BY timestamp DESC';
  
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    
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
  });
});

app.post('/api/stories', (req, res) => {
  const { name, address, category, amount, story, publicName, story_expenses } = req.body;
  
  if (!name || !address || !category || !amount || !story) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (isNaN(parseFloat(amount)) || parseFloat(amount) < 0 || parseFloat(amount) > 100000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  if (story.length < 10 || story.length > 5000) {
    return res.status(400).json({ error: 'Story must be 10-5000 characters' });
  }
  
  const ipHash = hashIP(req.ip);
  
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  db.get(
    'SELECT COUNT(*) as count FROM stories WHERE ipHash = ? AND timestamp > ?',
    [ipHash, oneDayAgo],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (row && row.count >= 5) {
        return res.status(429).json({ error: 'Too many submissions from this location. Please try again later.' });
      }
      
      db.run(
        'INSERT INTO stories (name, address, category, amount, story, publicName, story_expenses, ipHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [name, address, category, parseFloat(amount), story, publicName ? 1 : 0, story_expenses || '[]', ipHash],
        function(err) {
          if (err) {
            console.error('Insert error:', err);
            return res.status(500).json({ error: 'Failed to save story' });
          }
          
          res.json({
            success: true,
            id: this.lastID,
            message: 'Your story has been posted'
          });
        }
      );
    }
  );
});

app.get('/api/export/csv', (req, res) => {
  db.all('SELECT name, address, category, amount, story, publicName, story_expenses, timestamp FROM stories ORDER BY timestamp DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Export failed' });
    }
    
    const data = rows.map(r => {
      let expenses = [];
      try {
        expenses = JSON.parse(r.story_expenses || '[]');
      } catch (e) {
        expenses = [];
      }
      
      const expenseBreakdown = expenses.map(exp => `${exp.category}: $${exp.amount}`).join('; ');
      
      return {
        name: r.publicName ? r.name : 'Anonymous',
        address: r.address,
        category: r.category,
        amount: r.amount,
        expenses: expenseBreakdown,
        story: r.story,
        date: new Date(r.timestamp).toLocaleDateString()
      };
    });
    
    try {
      const json2csvParser = new Parser();
      const csv = json2csvParser.parse(data);
      
      res.header('Content-Type', 'text/csv');
      res.header('Content-Disposition', 'attachment; filename="gg-evacuation-claims.csv"');
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: 'CSV generation failed' });
    }
  });
});

app.get('/api/export/json', (req, res) => {
  db.all('SELECT name, address, category, amount, story, publicName, story_expenses, timestamp FROM stories ORDER BY timestamp DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Export failed' });
    }
    
    const data = {
      exportDate: new Date().toISOString(),
      totalStories: rows.length,
      totalCost: rows.reduce((sum, r) => sum + r.amount, 0),
      stories: rows.map(r => {
        let expenses = [];
        try {
          expenses = JSON.parse(r.story_expenses || '[]');
        } catch (e) {
          expenses = [];
        }
        
        return {
          name: r.publicName ? r.name : 'Anonymous',
          address: r.address,
          category: r.category,
          amount: r.amount,
          expenses: expenses,
          story: r.story,
          date: new Date(r.timestamp).toLocaleDateString()
        };
      })
    };
    
    res.header('Content-Type', 'application/json');
    res.header('Content-Disposition', 'attachment; filename="gg-evacuation-claims.json"');
    res.send(JSON.stringify(data, null, 2));
  });
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT}`);
});
