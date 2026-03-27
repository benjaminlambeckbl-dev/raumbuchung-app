'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(VOLUME_PATH, 'db.json');

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

// ── E-Mail ───────────────────────────────────────────────────────────────────

function buildEmailHtml(entry) {
  const skip = new Set(['id', 'receivedAt', 'submittedAt', 'privacy']);
  const labels = {
    fullName: 'Name', email: 'E-Mail', phone: 'Telefon', city: 'Wohnort',
    website: 'Website', linkedin: 'LinkedIn/Xing',
    availability: 'Verfügbarkeit', availNote: 'Verfügbarkeit – Hinweis',
    regions1: 'Einsatzgebiete primär', regions2: 'Einsatzgebiete sekundär',
    regions3: 'Einsatzgebiete gelegentlich', targetGroups: 'Zielgruppen',
    topics: 'Themenfelder', topics5a: '5A Unterrichtsentwicklung',
    topics5b: '5B Schulentwicklung', topics5c: '5C Führung & Leitung',
    topics5d: '5D Beratung & Coaching', topics5e: '5E Gesundheit',
    topics5f: '5F Digitalisierung/KI',
    schoolWork: 'Im Schulwesen tätig', schoolYears: 'Wie lange',
    totalDays: 'Gesamtzahl Fortbildungstage',
    formats: 'Formate', formatsOther: 'Formate – Sonstiges',
    additionalFormats: 'Zusatzformate', addFormatsSonstiges: 'Zusatzformate – Sonstiges',
    tools: 'Digitale Tools', languages: 'Sprachen',
    cert1: 'Zertifizierung 1', cert2: 'Zertifizierung 2', cert3: 'Zertifizierung 3',
    ref1name: 'Referenz 1 Name', ref1contact: 'Referenz 1 Kontakt',
    ref2name: 'Referenz 2 Name', ref2contact: 'Referenz 2 Kontakt',
    misc: 'Sonstiges / Motivation'
  };
  const rows = Object.entries(entry)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(', ') : String(v || '');
      if (!val) return '';
      const label = labels[k] || k;
      return `<tr><td style="padding:7px 14px;font-weight:600;background:#f0f8f9;border:1px solid #cce0e5;white-space:nowrap;color:#00364a">${label}</td>`
           + `<td style="padding:7px 14px;border:1px solid #cce0e5;color:#333">${val.replace(/\n/g,'<br>')}</td></tr>`;
    }).join('');
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#00364a;max-width:700px;margin:0 auto">
    <h2 style="background:#00364a;color:#00aaa2;padding:20px 24px;border-radius:8px 8px 0 0;margin:0">Neue Bildungstäter:in-Bewerbung</h2>
    <p style="padding:16px 24px;background:#fff;margin:0;border:1px solid #cce0e5;border-top:none">
      Eingegangen am: <strong>${new Date(entry.receivedAt).toLocaleString('de-DE')}</strong>
    </p>
    <table style="border-collapse:collapse;width:100%;border:1px solid #cce0e5;border-top:none">${rows}</table>
    </body></html>`;
}

async function sendTrainerEmail(entry) {
  if (!process.env.SMTP_HOST) return;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || `"ISH Gruppe Formular" <${process.env.SMTP_USER}>`,
      to: 'office@ish-gruppe.de',
      subject: `Neue Bildungstäter:in-Bewerbung: ${entry.fullName}`,
      html: buildEmailHtml(entry)
    });
    console.log(`[Mail] Bewerbung von ${entry.fullName} versendet`);
  } catch (err) {
    console.error('[Mail] Fehler beim Versand:', err.message);
  }
}

// ── Trainer:innen-Bewerbungen ────────────────────────────────────────────────

const TRAINERS_FILE = process.env.TRAINERS_FILE || path.join(VOLUME_PATH, 'trainers.json');

function loadTrainers() {
  try { return JSON.parse(fs.readFileSync(TRAINERS_FILE, 'utf8')); }
  catch { return []; }
}

app.post('/api/trainer-apply', (req, res) => {
  const body = req.body;
  if (!body || !body.fullName || !body.email) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen: fullName, email' });
  }

  const id = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  const entry = { id, ...body, receivedAt: new Date().toISOString() };

  const trainers = loadTrainers();
  trainers.push(entry);
  fs.mkdirSync(path.dirname(TRAINERS_FILE), { recursive: true });
  fs.writeFileSync(TRAINERS_FILE, JSON.stringify(trainers, null, 2));

  console.log(`[Trainer-Bewerbung] ${entry.fullName} <${entry.email}> (ID: ${id})`);
  sendTrainerEmail(entry).catch(() => {});
  res.json({ success: true, id });
});

app.get('/api/trainer-applications', (req, res) => {
  res.json(loadTrainers());
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Raumbuchung läuft auf Port ${PORT}`));
