'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

// ── Datenspeicher ────────────────────────────────────────────────────────────

const DEFAULT = {
  bookings: [],
  settings: { rooms: ['Raum A', 'Raum B', 'Konferenzraum'], startHour: 8, endHour: 17 },
  lastModified: 0
};

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return structuredClone(DEFAULT); }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Server-Sent Events (Echtzeit-Sync) ──────────────────────────────────────

const clients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE Endpoint ─────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(': connected\n\n');

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ── API Routen ───────────────────────────────────────────────────────────────

app.get('/rb-settings', (req, res) => {
  const db = load();
  res.json(db.settings);
});

app.post('/rb-settings-save', (req, res) => {
  const { rooms, startHour, endHour } = req.body;
  if (!Array.isArray(rooms) || rooms.length === 0)
    return res.status(400).json({ error: 'rooms array fehlt oder leer' });

  const db = load();
  db.settings = {
    rooms: rooms.map(r => String(r).trim()).filter(r => r.length > 0),
    startHour: Math.max(0, Math.min(23, parseInt(startHour) || 8)),
    endHour:   Math.max(1, Math.min(24, parseInt(endHour)   || 18))
  };
  save(db);
  broadcast('settings', db.settings);
  res.json({ success: true, settings: db.settings });
});

app.get('/rb-bookings', (req, res) => {
  const db = load();
  const { from, to } = req.query;
  let bookings = db.bookings.slice();
  if (from) bookings = bookings.filter(b => b.date >= from);
  if (to)   bookings = bookings.filter(b => b.date <= to);
  res.json({ bookings, lastModified: db.lastModified });
});

app.post('/rb-booking-create', (req, res) => {
  const { room, date, hour, name, note } = req.body;
  if (!room || !date || hour == null || !name)
    return res.status(400).json({ error: 'Pflichtfelder fehlen: room, date, hour, name' });

  const db = load();
  const h = parseInt(hour);
  const conflict = db.bookings.find(b => b.room === room && b.date === date && b.hour === h);
  if (conflict)
    return res.status(409).json({ error: 'Bereits gebucht von: ' + conflict.name });

  const id = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  const booking = { id, room, date, hour: h, name: name.trim(), note: (note || '').trim(), createdAt: new Date().toISOString() };
  db.bookings.push(booking);
  db.lastModified = Date.now();
  save(db);
  broadcast('booking-created', booking);
  res.json({ booking });
});

app.post('/rb-booking-cancel', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID fehlt' });

  const db = load();
  const idx = db.bookings.findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Buchung nicht gefunden' });

  const deleted = db.bookings.splice(idx, 1)[0];
  db.lastModified = Date.now();
  save(db);
  broadcast('booking-cancelled', { id });
  res.json({ success: true, deleted });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Raumbuchung läuft auf Port ${PORT}`));
