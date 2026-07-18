import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'farmguard.db');

export async function initDb() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.get('PRAGMA foreign_keys = ON');

  // Create Users table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'owner'
    )
  `);

  // Create Device status table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_armed INTEGER DEFAULT 0,
      battery_level INTEGER DEFAULT 100,
      signal_strength INTEGER DEFAULT 5, -- 0-5 stars
      last_heartbeat TEXT
    )
  `);

  // Create Events table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      media_path TEXT,
      media_type TEXT, -- 'photo' or 'video'
      detection_type TEXT NOT NULL, -- 'Human Detected', 'Recognized Owner', 'Animal Ignored'
      zone_name TEXT,
      is_recognized INTEGER DEFAULT 0 -- 1 = recognized, 0 = unrecognized
    )
  `);

  // Create Alerts table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL, -- 'SMS', 'Push'
      message TEXT NOT NULL,
      status TEXT NOT NULL -- 'Delivered', 'Sent', 'Failed'
    )
  `);

  // Create Authorized Biometrics table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS authorized_biometrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'RFID', 'Face'
      identifier TEXT UNIQUE NOT NULL, -- tag ID or facial encoding hash
      enrolled_at TEXT NOT NULL
    )
  `);

  // Create Zones table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'rectangle', 'radius'
      coordinates TEXT NOT NULL -- JSON string of zone details e.g. center, radius or bounds
    )
  `);

  // Create Livestock table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS livestock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tag_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'Safe' -- 'Safe', 'Warning (Near boundary)', 'Breached'
    )
  `);

  // Create Livestock Locations table (history tracking)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS livestock_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      livestock_id INTEGER,
      timestamp TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      FOREIGN KEY(livestock_id) REFERENCES livestock(id) ON DELETE CASCADE
    )
  `);

  // Create Faces table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      employee_id TEXT UNIQUE,
      department TEXT,
      face_encoding_id INTEGER, -- ID used by ESP32 (usually 1-N)
      registered_at TEXT NOT NULL,
      status TEXT DEFAULT 'Active' -- 'Active', 'Disabled'
    )
  `);

  // Create RFID Cards table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS rfid_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      user_name TEXT, -- Optionally tie to a face name or standalone
      status TEXT DEFAULT 'Active', -- 'Active', 'Inactive'
      registered_at TEXT NOT NULL
    )
  `);


  // Create Unknown Faces table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS unknown_faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_path TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  // Seed default admin user if empty
  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    const salt = await bcrypt.genSalt(10);
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || 'admin123';
    const passwordHash = await bcrypt.hash(initialPassword, salt);
    await db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['admin', passwordHash, 'owner']);
    console.log(`Seeded admin user (user: admin, pass: ${process.env.INITIAL_ADMIN_PASSWORD ? '********' : 'admin123'})`);
  }

  // Seed default device if empty
  const deviceCount = await db.get('SELECT COUNT(*) as count FROM devices');
  if (deviceCount.count === 0) {
    await db.run(
      `INSERT INTO devices (id, name, is_armed, battery_level, signal_strength, last_heartbeat) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['ESP32-FG-001', 'Main Farm ESP32 Gatekeeper', 1, 87, 4, new Date().toISOString()]
    );
    console.log('Seeded ESP32 device status');
  }

  // Seed biometrics if empty (Disabled to prevent fake data in production)
  // Seeding removed per user request



  return db;
}
