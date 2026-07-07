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

  // Seed biometrics if empty
  const bioCount = await db.get('SELECT COUNT(*) as count FROM authorized_biometrics');
  if (bioCount.count === 0) {
    const now = new Date().toISOString();
    await db.run(`INSERT INTO authorized_biometrics (name, type, identifier, enrolled_at) VALUES (?, ?, ?, ?)`, ['John (Owner)', 'Face', 'face_enc_john_182f0', now]);
    await db.run(`INSERT INTO authorized_biometrics (name, type, identifier, enrolled_at) VALUES (?, ?, ?, ?)`, ['Sarah (Family)', 'RFID', 'RFID_A892F1C', now]);
    await db.run(`INSERT INTO authorized_biometrics (name, type, identifier, enrolled_at) VALUES (?, ?, ?, ?)`, ['Dave (Ranger)', 'RFID', 'RFID_B129C3E', now]);
    console.log('Seeded biometric users');
  }

  // Seed default detection zones if empty
  const zoneCount = await db.get('SELECT COUNT(*) as count FROM zones');
  if (zoneCount.count === 0) {
    await db.run(`INSERT INTO zones (name, type, coordinates) VALUES (?, ?, ?)`, [
      'North Pasture Gate',
      'rectangle',
      JSON.stringify({ x: 10, y: 15, width: 45, height: 40 })
    ]);
    await db.run(`INSERT INTO zones (name, type, coordinates) VALUES (?, ?, ?)`, [
      'Main Barn Entrance',
      'radius',
      JSON.stringify({ x: 60, y: 50, radius: 25 })
    ]);
    console.log('Seeded detection zones');
  }

  // Seed default livestock if empty
  const liveCount = await db.get('SELECT COUNT(*) as count FROM livestock');
  if (liveCount.count === 0) {
    await db.run(`INSERT INTO livestock (name, tag_id, status) VALUES (?, ?, ?)`, ['Cow-01 (Bessie)', 'LIV_COW_001', 'Safe']);
    await db.run(`INSERT INTO livestock (name, tag_id, status) VALUES (?, ?, ?)`, ['Cow-02 (Bella)', 'LIV_COW_002', 'Safe']);
    await db.run(`INSERT INTO livestock (name, tag_id, status) VALUES (?, ?, ?)`, ['Sheep-01 (Dolly)', 'LIV_SHP_001', 'Warning (Near boundary)']);
    console.log('Seeded livestock');

    // Seed location history for Bessie, Bella, and Dolly
    // Base center of farm around Lat: 37.7749, Lng: -122.4194 (or standard rural coordinates e.g. 34.0522, -118.2437)
    // Let's use coordinates near a farm: 38.3245, -122.6512 (Santa Rosa, CA farm region)
    const baseCoords = { lat: 38.3245, lng: -122.6512 };
    const nowTs = new Date();

    // Bessie locations
    for (let i = 5; i >= 0; i--) {
      const ts = new Date(nowTs.getTime() - i * 600000).toISOString(); // every 10 min
      await db.run(`INSERT INTO livestock_locations (livestock_id, timestamp, lat, lng) VALUES (?, ?, ?, ?)`, [
        1, ts, baseCoords.lat + i * 0.0001, baseCoords.lng + i * 0.00015
      ]);
    }
    // Bella locations
    for (let i = 5; i >= 0; i--) {
      const ts = new Date(nowTs.getTime() - i * 600000).toISOString();
      await db.run(`INSERT INTO livestock_locations (livestock_id, timestamp, lat, lng) VALUES (?, ?, ?, ?)`, [
        2, ts, baseCoords.lat - i * 0.00008, baseCoords.lng + i * 0.0002
      ]);
    }
    // Dolly locations (which exited geofence)
    // Geofence center: 38.3245, -122.6512, size/radius: ~300 meters (~0.0027 degrees latitude/longitude)
    for (let i = 5; i >= 0; i--) {
      const ts = new Date(nowTs.getTime() - i * 600000).toISOString();
      // Increments outside geofence boundary (0.003 difference is outside boundary)
      const latDiff = i * 0.0006;
      await db.run(`INSERT INTO livestock_locations (livestock_id, timestamp, lat, lng) VALUES (?, ?, ?, ?)`, [
        3, ts, baseCoords.lat + latDiff + 0.001, baseCoords.lng - i * 0.0004
      ]);
    }
    console.log('Seeded livestock locations history');
  }

  // Seed events if empty
  const eventCount = await db.get('SELECT COUNT(*) as count FROM events');
  if (eventCount.count === 0) {
    const now = new Date();
    await db.run(`INSERT INTO events (timestamp, media_path, media_type, detection_type, zone_name, is_recognized) VALUES (?, ?, ?, ?, ?, ?)`, [
      new Date(now.getTime() - 7200000).toISOString(), // 2 hours ago
      '/uploads/event1.jpg',
      'photo',
      'Recognized Owner',
      'Main Barn Entrance',
      1
    ]);
    await db.run(`INSERT INTO events (timestamp, media_path, media_type, detection_type, zone_name, is_recognized) VALUES (?, ?, ?, ?, ?, ?)`, [
      new Date(now.getTime() - 3600000).toISOString(), // 1 hour ago
      '/uploads/event2.jpg',
      'photo',
      'Animal Ignored',
      'North Pasture Gate',
      0
    ]);
    await db.run(`INSERT INTO events (timestamp, media_path, media_type, detection_type, zone_name, is_recognized) VALUES (?, ?, ?, ?, ?, ?)`, [
      new Date(now.getTime() - 900000).toISOString(), // 15 mins ago
      '/uploads/event3.jpg',
      'photo',
      'Human Detected',
      'North Pasture Gate',
      0
    ]);
    console.log('Seeded security events');
  }

  // Seed alerts if empty
  const alertCount = await db.get('SELECT COUNT(*) as count FROM alerts');
  if (alertCount.count === 0) {
    const now = new Date();
    await db.run(`INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)`, [
      new Date(now.getTime() - 7200000).toISOString(),
      'Push',
      'Authorized entry: John (Owner) recognized at Main Barn Entrance.',
      'Delivered'
    ]);
    await db.run(`INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)`, [
      new Date(now.getTime() - 900000).toISOString(),
      'SMS',
      'FarmGuard WARNING: Unrecognized Human detected in North Pasture Gate zone! Arm state: ARMED.',
      'Delivered'
    ]);
    console.log('Seeded alerts log');
  }

  return db;
}
