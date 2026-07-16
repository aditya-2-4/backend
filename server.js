import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import crypto from 'crypto';

// Unbuffer stdout for immediate logging in production environments like Render
if (process.stdout._handle && typeof process.stdout._handle.setBlocking === 'function') {
  process.stdout._handle.setBlocking(true);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Check if default secret is used in production
let JWT_SECRET = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET === 'farmguard_secret_key_123')) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
} else {
  JWT_SECRET = JWT_SECRET || 'farmguard_secret_key_123';
}

const app = express();
const server = createServer(app);

// Configure CORS securely
const allowedOrigin = process.env.CORS_ORIGIN;
app.use(cors({
  origin: allowedOrigin ? allowedOrigin : (origin, callback) => callback(null, true),
  credentials: true
}));
app.use(express.json());

// Create uploads directory if not exists
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files statically
app.use('/uploads', express.static(uploadsDir));

// Initialize Database connection
let db;
try {
  db = await initDb();
  console.log('Database connected and initialized.');
} catch (err) {
  console.error('Failed to initialize database:', err);
  process.exit(1);
}

// Set up Multer with file type filter and size limit (5MB)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and MP4/MOV videos are permitted.'), false);
  }
};
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter
});

// Set up WebSocket server
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`WebSocket client connected. Active connections: ${clients.size}`);
  
  // Send current status immediately on connect
  sendSystemStatus(ws);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket client disconnected. Active connections: ${clients.size}`);
  });
});

// Upgrade HTTP server to WebSocket
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Broadcast helper
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

async function sendSystemStatus(ws) {
  try {
    const device = await db.get('SELECT * FROM devices LIMIT 1');
    const recentEvents = await db.all('SELECT * FROM events ORDER BY timestamp DESC LIMIT 5');
    const response = {
      type: 'STATUS_UPDATE',
      device,
      recentEvents
    };
    ws.send(JSON.stringify(response));
  } catch (err) {
    console.error('Error sending system status over WS:', err);
  }
}

// Write placeholder files for events so the dashboard can render image previews
function writePlaceholderFiles() {
  const files = ['event1.jpg', 'event2.jpg', 'event3.jpg'];
  // Create a minimal 1x1 pixel black GIF base64 or a tiny valid JPEG
  const tinyJpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  
  files.forEach(file => {
    const filepath = path.join(uploadsDir, file);
    if (!fs.existsSync(filepath)) {
      fs.writeFileSync(filepath, tinyJpg);
      console.log(`Created placeholder file: ${file}`);
    }
  });
}
writePlaceholderFiles();

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Redirect root path to the health check dashboard
app.get('/', (req, res) => {
  res.redirect('/api/health');
});

// Public Health Check Endpoint (For direct browser click testing!)
app.get('/api/health', async (req, res) => {
  let isOnline = false;
  if (db) {
    try {
      const device = await db.get('SELECT last_heartbeat FROM devices LIMIT 1');
      if (device && device.last_heartbeat) {
        const lastHb = new Date(device.last_heartbeat).getTime();
        const now = Date.now();
        // Consider offline if no heartbeat for 15 seconds
        if (now - lastHb < 15000) {
          isOnline = true;
        }
      }
    } catch (e) {
      console.error('Error checking device status for health API', e);
    }
  }

  const healthData = {
    status: isOnline ? 'online' : 'offline',
    service: 'FarmGuard Gateway API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected'
  };

  // If requested by a web browser, return a beautiful high-tech GUI
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    const formatUptime = (seconds) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      return `${h}h ${m}m ${s}s`;
    };

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>FarmGuard API Status HUD</title>
        <style>
          body {
            background-color: #0a0a0a;
            color: #d2d2d2;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
          }
          .card {
            background-color: #121212;
            border: 1px solid #2e854e;
            border-radius: 12px;
            padding: 30px;
            width: 90%;
            max-width: 500px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.8);
            box-sizing: border-box;
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 25px;
            border-bottom: 1px solid #1f1f1f;
            padding-bottom: 15px;
          }
          .title {
            color: #ffffff;
            font-size: 22px;
            font-weight: 800;
            margin: 0;
            letter-spacing: -0.5px;
          }
          .badge {
            background-color: rgba(46, 133, 78, 0.15);
            color: #10b981;
            border: 1px solid rgba(16, 185, 129, 0.3);
            font-weight: bold;
            font-size: 11px;
            padding: 4px 10px;
            border-radius: 20px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .badge.offline {
            background-color: rgba(239, 68, 68, 0.15);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.3);
          }
          .pulse {
            width: 8px;
            height: 8px;
            background-color: #10b981;
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 8px #10b981;
            animation: pulse-animation 1.5s infinite;
          }
          .pulse.offline {
            background-color: #ef4444;
            box-shadow: none;
            animation: none;
          }
          @keyframes pulse-animation {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
          }
          .grid {
            display: grid;
            grid-template-cols: 1fr;
            gap: 15px;
            margin-bottom: 25px;
          }
          .item {
            background-color: #1a1a1a;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            padding: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .label {
            color: #8b949e;
            font-size: 13px;
            font-weight: 500;
          }
          .value {
            color: #f0f6fc;
            font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace;
            font-size: 14px;
            font-weight: 700;
          }
          .green { color: #10b981; }
          .btn {
            display: block;
            background-color: #2e854e;
            color: white;
            text-align: center;
            text-decoration: none;
            padding: 12px;
            border-radius: 8px;
            font-weight: bold;
            font-size: 14px;
            transition: background-color 0.2s;
          }
          .btn:hover {
            background-color: #3fa364;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h1 class="title">FarmGuard API</h1>
            <div class="badge ${!isOnline ? 'offline' : ''}">
              <span class="pulse ${!isOnline ? 'offline' : ''}"></span>
              <span>${isOnline ? 'Online' : 'Offline'}</span>
            </div>
          </div>
          <div class="grid">
            <div class="item">
              <span class="label">Service Name</span>
              <span class="value">${healthData.service}</span>
            </div>
            <div class="item">
              <span class="label">Database Status</span>
              <span class="value green">${healthData.database.toUpperCase()}</span>
            </div>
            <div class="item">
              <span class="label">System Uptime</span>
              <span class="value">${formatUptime(healthData.uptime)}</span>
            </div>
            <div class="item">
              <span class="label">Server Epoch</span>
              <span class="value" style="font-size: 11px;">${healthData.timestamp}</span>
            </div>
          </div>
          <a href="${process.env.FRONTEND_URL || allowedOrigin || 'https://frontend-six-tau-93.vercel.app'}" class="btn">Open Main Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } else {
    res.json(healthData);
  }
});

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token missing' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// Role authorization check middleware
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Unauthorized role permissions' });
    }
    next();
  };
};

// ESP32 Shared Key verification middleware
const verifyDeviceApiKey = (req, res, next) => {
  const deviceKey = req.headers['x-api-key'] || req.query.api_key;
  const configuredKey = process.env.DEVICE_API_KEY || 'secure_esp32_device_shared_api_key_2026';
  
  if (!deviceKey || deviceKey !== configuredKey) {
    return res.status(403).json({ error: 'Unauthorized device key access' });
  }
  next();
};

// Login Route
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 1. Event Log Endpoints
app.get('/api/events', authenticateToken, async (req, res) => {
  const { type, is_recognized, startDate, endDate } = req.query;
  let query = 'SELECT * FROM events WHERE 1=1';
  const params = [];

  if (type) {
    query += ' AND detection_type = ?';
    params.push(type);
  }

  if (is_recognized !== undefined && is_recognized !== '') {
    query += ' AND is_recognized = ?';
    params.push(parseInt(is_recognized));
  }

  if (startDate) {
    query += ' AND timestamp >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND timestamp <= ?';
    params.push(endDate);
  }

  query += ' ORDER BY timestamp DESC';

  try {
    const events = await db.all(query, params);
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve events' });
  }
});

// ESP32 Device Endpoint to post new event and upload photo/video
app.post('/api/device/event', verifyDeviceApiKey, upload.single('media'), async (req, res) => {
  const { detection_type, zone_name, is_recognized, timestamp } = req.body;

  if (!detection_type) {
    return res.status(400).json({ error: 'detection_type is required' });
  }

  const ts = timestamp || new Date().toISOString();
  let mediaPath = null;
  let mediaType = null;

  if (req.file) {
    mediaPath = `/uploads/${req.file.filename}`;
    mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
  }

  const recognized = parseInt(is_recognized) || 0;

  try {
    const result = await db.run(
      `INSERT INTO events (timestamp, media_path, media_type, detection_type, zone_name, is_recognized) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ts, mediaPath, mediaType, detection_type, zone_name || 'General Field', recognized]
    );

    const newEventId = result.lastID;
    const newEvent = await db.get('SELECT * FROM events WHERE id = ?', [newEventId]);

    // Send Alert message if it is an unrecognized human intrusion
    if (detection_type === 'Human Detected' && recognized === 0) {
      const alertMsg = `FarmGuard ALERT: Unrecognized Intrusion detected in ${zone_name || 'General Field'}!`;
      
      // Save Alert logs
      await db.run('INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)', [ts, 'SMS', alertMsg, 'Delivered']);
      await db.run('INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)', [ts, 'Push', alertMsg, 'Delivered']);
      
      // Broadcast alerts along with event
      broadcast({
        type: 'NEW_INTRUSION',
        event: newEvent,
        alert: { timestamp: ts, message: alertMsg }
      });
    } else {
      // Just broadcast standard event
      broadcast({
        type: 'NEW_EVENT',
        event: newEvent
      });
    }

    res.status(201).json({ success: true, event: newEvent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// 2. Alert Log Endpoints
app.get('/api/alerts', authenticateToken, async (req, res) => {
  try {
    const alerts = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

// Manual alert resend testing endpoint
app.post('/api/alerts/resend/:id', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { id } = req.params;
  try {
    const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [id]);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    // Insert new alert as a "resend" copy
    const ts = new Date().toISOString();
    const resendMsg = `[RESENT] ${alert.message}`;
    await db.run(
      'INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)',
      [ts, alert.type, resendMsg, 'Delivered']
    );

    const latestAlert = await db.get('SELECT * FROM alerts ORDER BY id DESC LIMIT 1');

    // Broadcast new alert
    broadcast({
      type: 'ALERT_RESENT',
      alert: latestAlert
    });

    res.json({ success: true, message: 'Alert resent successfully', alert: latestAlert });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resend alert' });
  }
});

// 3. User & Biometrics Management
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const biometrics = await db.all('SELECT * FROM authorized_biometrics ORDER BY enrolled_at DESC');
    res.json(biometrics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve biometrics' });
  }
});

app.post('/api/users', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { name, type, identifier } = req.body;
  if (!name || !type || !identifier) {
    return res.status(400).json({ error: 'Name, Type (RFID/Face), and Identifier are required' });
  }

  try {
    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO authorized_biometrics (name, type, identifier, enrolled_at) VALUES (?, ?, ?, ?)',
      [name, type, identifier, now]
    );

    const newUser = await db.get('SELECT * FROM authorized_biometrics WHERE identifier = ?', [identifier]);
    
    // Broadcast user enrollment sync
    broadcast({
      type: 'BIOMETRIC_ENROLLED',
      user: newUser
    });

    res.status(201).json(newUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to enroll user (Identifier must be unique)' });
  }
});

app.delete('/api/users/:id', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { id } = req.params;
  try {
    const user = await db.get('SELECT * FROM authorized_biometrics WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await db.run('DELETE FROM authorized_biometrics WHERE id = ?', [id]);
    
    // Broadcast delete event
    broadcast({
      type: 'BIOMETRIC_REMOVED',
      userId: id
    });

    res.json({ success: true, message: 'User removed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// Silent recognized entry history logs
app.get('/api/users/history', authenticateToken, async (req, res) => {
  try {
    const entries = await db.all(`
      SELECT * FROM events 
      WHERE is_recognized = 1 AND detection_type = 'Recognized Owner' 
      ORDER BY timestamp DESC
    `);
    res.json(entries);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve recognized history' });
  }
});

// 4. Detection Zone Configuration
app.get('/api/zones', authenticateToken, async (req, res) => {
  try {
    const zones = await db.all('SELECT * FROM zones');
    // Parse coordinates string back to JSON objects
    const parsedZones = zones.map(z => ({
      ...z,
      coordinates: JSON.parse(z.coordinates)
    }));
    res.json(parsedZones);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve zones' });
  }
});

app.post('/api/zones', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { zonesList } = req.body; // Expecting array of zones
  if (!Array.isArray(zonesList)) {
    return res.status(400).json({ error: 'zonesList array required' });
  }

  try {
    // Clear old zones and rewrite (or update based on ID)
    await db.run('DELETE FROM zones');
    for (const zone of zonesList) {
      await db.run(
        'INSERT INTO zones (name, type, coordinates) VALUES (?, ?, ?)',
        [zone.name, zone.type, JSON.stringify(zone.coordinates)]
      );
    }

    const updatedZones = await db.all('SELECT * FROM zones');
    const parsedZones = updatedZones.map(z => ({
      ...z,
      coordinates: JSON.parse(z.coordinates)
    }));

    // Broadcast sync event to device / frontends
    broadcast({
      type: 'ZONES_UPDATED',
      zones: parsedZones
    });

    res.json({ success: true, zones: parsedZones });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save zones' });
  }
});

// 5. Livestock GPS Tracking
app.get('/api/livestock', authenticateToken, async (req, res) => {
  try {
    const livestockList = await db.all('SELECT * FROM livestock');
    
    // Attach current coordinates (latest location record)
    const result = [];
    for (const animal of livestockList) {
      const latestLoc = await db.get(
        'SELECT lat, lng, timestamp FROM livestock_locations WHERE livestock_id = ? ORDER BY timestamp DESC LIMIT 1',
        [animal.id]
      );
      result.push({
        ...animal,
        currentLocation: latestLoc || null
      });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve livestock list' });
  }
});

app.get('/api/livestock/:id/locations', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const history = await db.all(
      'SELECT lat, lng, timestamp FROM livestock_locations WHERE livestock_id = ? ORDER BY timestamp ASC',
      [id]
    );
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve location history' });
  }
});

// ESP32 or GPS Collar pushes updated GPS location
app.post('/api/device/livestock/location', verifyDeviceApiKey, async (req, res) => {
  const { tag_id, lat, lng } = req.body;
  if (!tag_id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'tag_id, lat, and lng are required' });
  }

  try {
    const animal = await db.get('SELECT * FROM livestock WHERE tag_id = ?', [tag_id]);
    if (!animal) return res.status(404).json({ error: 'Livestock not registered' });

    const ts = new Date().toISOString();
    await db.run(
      'INSERT INTO livestock_locations (livestock_id, timestamp, lat, lng) VALUES (?, ?, ?, ?)',
      [animal.id, ts, lat, lng]
    );

    // Geofencing Check
    // Center: 28.6139, 77.2090 (India). Radius: ~300 meters which is ~0.0027 lat/lng degrees.
    const geofenceCenter = { lat: 28.6139, lng: 77.2090 };
    const dist = Math.sqrt(Math.pow(lat - geofenceCenter.lat, 2) + Math.pow(lng - geofenceCenter.lng, 2));
    
    let status = 'Safe';
    if (dist > 0.0027) {
      status = 'Breached';
    } else if (dist > 0.002) {
      status = 'Warning (Near boundary)';
    }

    if (status !== animal.status) {
      await db.run('UPDATE livestock SET status = ? WHERE id = ?', [status, animal.id]);
      
      // If breached, trigger safety event and push alert
      if (status === 'Breached') {
        const breachMsg = `FarmGuard ALERT: Geofence BREACHED! Livestock ${animal.name} (${tag_id}) has exited the safety zone!`;
        
        await db.run('INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)', [ts, 'SMS', breachMsg, 'Delivered']);
        await db.run('INSERT INTO alerts (timestamp, type, message, status) VALUES (?, ?, ?, ?)', [ts, 'Push', breachMsg, 'Delivered']);
        
        broadcast({
          type: 'GEOFENCE_BREACH',
          livestock: { ...animal, status, currentLocation: { lat, lng, timestamp: ts } },
          alert: { timestamp: ts, message: breachMsg }
        });
      }
    }

    const updatedAnimal = {
      ...animal,
      status,
      currentLocation: { lat, lng, timestamp: ts }
    };

    // Broadcast location update to map client
    broadcast({
      type: 'LIVESTOCK_LOCATION_UPDATE',
      livestock: updatedAnimal
    });

    res.json({ success: true, status, distanceDegrees: dist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// 6. Device Heartbeat & ARM Control Status
app.get('/api/device/status', authenticateToken, async (req, res) => {
  try {
    const device = await db.get('SELECT * FROM devices LIMIT 1');
    res.json(device);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve device status' });
  }
});

app.post('/api/device/status', verifyDeviceApiKey, async (req, res) => {
  const { device_id, battery_level, signal_strength, is_armed } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });

  try {
    const ts = new Date().toISOString();
    
    // Update or insert device heartbeat
    const existing = await db.get('SELECT * FROM devices WHERE id = ?', [device_id]);
    if (existing) {
      await db.run(
        `UPDATE devices 
         SET last_heartbeat = ?, 
             battery_level = COALESCE(?, battery_level), 
             signal_strength = COALESCE(?, signal_strength),
             is_armed = COALESCE(?, is_armed)
         WHERE id = ?`,
        [ts, battery_level, signal_strength, is_armed !== undefined ? (is_armed ? 1 : 0) : null, device_id]
      );
    } else {
      await db.run(
        `INSERT INTO devices (id, name, is_armed, battery_level, signal_strength, last_heartbeat) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [device_id, 'ESP32 Security Node', is_armed ? 1 : 0, battery_level || 100, signal_strength || 5, ts]
      );
    }

    const updatedDevice = await db.get('SELECT * FROM devices WHERE id = ?', [device_id]);
    
    // Broadcast updated heartbeat status to all connected dashboards
    broadcast({
      type: 'DEVICE_HEARTBEAT',
      device: updatedDevice
    });

    res.json({ success: true, device: updatedDevice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post device status' });
  }
});

// Arm/Disarm Toggle endpoint for web dashboard
app.post('/api/device/arm-toggle', authenticateToken, async (req, res) => {
  const { is_armed } = req.body;
  if (is_armed === undefined) return res.status(400).json({ error: 'is_armed boolean required' });

  try {
    const armedVal = is_armed ? 1 : 0;
    await db.run('UPDATE devices SET is_armed = ?', [armedVal]);
    
    const updatedDevice = await db.get('SELECT * FROM devices LIMIT 1');
    
    // Broadcast status change
    broadcast({
      type: 'STATUS_UPDATE',
      device: updatedDevice
    });

    res.json({ success: true, device: updatedDevice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle arm state' });
  }
});

// ==========================================
// ESP32 SMART FACE RECOGNITION & RFID APIs
// ==========================================

// 7. Face Management Endpoints
app.get('/api/faces', authenticateToken, async (req, res) => {
  try {
    const faces = await db.all("SELECT * FROM faces ORDER BY registered_at DESC");
    res.json(faces);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve faces' });
  }
});

app.post('/api/faces/register', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { name, employee_id, department, face_encoding_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const ts = new Date().toISOString();
    await db.run(
      'INSERT INTO faces (name, employee_id, department, face_encoding_id, registered_at, status) VALUES (?, ?, ?, ?, ?, ?)',
      [name, employee_id || null, department || null, face_encoding_id || null, ts, 'Active']
    );

    const newFace = await db.get('SELECT * FROM faces WHERE id = last_insert_rowid()');
    
    broadcast({
      type: 'FACE_REGISTERED',
      face: newFace
    });

    res.status(201).json(newFace);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register face (employee ID might not be unique)' });
  }
});

app.put('/api/faces/:id', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { id } = req.params;
  const { name, employee_id, department, status } = req.body;
  try {
    const existing = await db.get('SELECT * FROM faces WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Face not found' });

    await db.run(
      'UPDATE faces SET name = ?, employee_id = ?, department = ?, status = ? WHERE id = ?',
      [name || existing.name, employee_id || existing.employee_id, department || existing.department, status || existing.status, id]
    );

    const updated = await db.get('SELECT * FROM faces WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update face' });
  }
});

app.delete('/api/faces/:id', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM faces WHERE id = ?', [id]);
    
    broadcast({
      type: 'FACE_DELETED',
      faceId: id
    });

    res.json({ success: true, message: 'Face removed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete face' });
  }
});

// 8. RFID Management Endpoints
app.get('/api/rfid', authenticateToken, async (req, res) => {
  try {
    const cards = await db.all("SELECT * FROM rfid_cards ORDER BY registered_at DESC");
    res.json(cards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve RFID cards' });
  }
});

app.post('/api/rfid/register', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { uid, user_name } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID is required' });

  try {
    const ts = new Date().toISOString();
    await db.run(
      'INSERT INTO rfid_cards (uid, user_name, status, registered_at) VALUES (?, ?, ?, ?)',
      [uid, user_name || null, 'Active', ts]
    );

    const newCard = await db.get('SELECT * FROM rfid_cards WHERE id = last_insert_rowid()');
    res.status(201).json(newCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register RFID (UID must be unique)' });
  }
});

app.put('/api/rfid/:id', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { id } = req.params;
  const { user_name, status } = req.body;
  try {
    const existing = await db.get('SELECT * FROM rfid_cards WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'RFID card not found' });

    await db.run(
      'UPDATE rfid_cards SET user_name = ?, status = ? WHERE id = ?',
      [user_name !== undefined ? user_name : existing.user_name, status || existing.status, id]
    );

    const updated = await db.get('SELECT * FROM rfid_cards WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update RFID card' });
  }
});

app.delete('/api/rfid/:id', authenticateToken, requireRole(['owner']), async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM rfid_cards WHERE id = ?', [id]);
    res.json({ success: true, message: 'RFID card removed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete RFID card' });
  }
});

// 9. Attendance Endpoints
app.get('/api/attendance', authenticateToken, async (req, res) => {
  try {
    const logs = await db.all("SELECT * FROM attendance ORDER BY timestamp DESC");
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve attendance logs' });
  }
});

// 10. ESP32 Event Webhooks (Face Recognized, RFID Scanned, Unknown Face)
app.post('/api/device/attendance', verifyDeviceApiKey, async (req, res) => {
  const { method, identifier, confidence } = req.body;
  // method: 'Face' or 'RFID'
  // identifier: Face ID or RFID UID
  if (!method || !identifier) {
    return res.status(400).json({ error: 'Method and identifier are required' });
  }

  try {
    const ts = new Date().toISOString();
    let personName = 'Unknown';

    if (method === 'Face') {
      const face = await db.get('SELECT name FROM faces WHERE face_encoding_id = ? AND status = "Active"', [identifier]);
      if (face) personName = face.name;
    } else if (method === 'RFID') {
      const rfid = await db.get('SELECT user_name FROM rfid_cards WHERE uid = ? AND status = "Active"', [identifier]);
      if (rfid && rfid.user_name) personName = rfid.user_name;
    }

    await db.run(
      'INSERT INTO attendance (person_name, method, identifier, confidence, timestamp) VALUES (?, ?, ?, ?, ?)',
      [personName, method, identifier, confidence || null, ts]
    );

    const log = await db.get('SELECT * FROM attendance WHERE id = last_insert_rowid()');

    if (method === 'Face') {
      broadcast({ type: 'FACE_RECOGNIZED', log });
    } else {
      broadcast({ type: 'RFID_SCANNED', log });
    }

    res.status(201).json({ success: true, log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record attendance' });
  }
});

// Unknown Face Event Endpoint (can upload image)
app.post('/api/device/unknown_face', verifyDeviceApiKey, upload.single('image'), async (req, res) => {
  try {
    const ts = new Date().toISOString();
    let imagePath = null;
    
    if (req.file) {
      imagePath = `/uploads/${req.file.filename}`;
    }

    await db.run('INSERT INTO unknown_faces (image_path, timestamp) VALUES (?, ?)', [imagePath, ts]);
    const unknownLog = await db.get('SELECT * FROM unknown_faces WHERE id = last_insert_rowid()');
    
    // Broadcast unknown face alert
    broadcast({ type: 'UNKNOWN_FACE', log: unknownLog });
    
    res.status(201).json({ success: true, log: unknownLog });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record unknown face' });
  }
});

// 11. Camera Stream Config Endpoint
app.get('/api/camera/config', authenticateToken, async (req, res) => {
  // Returns the expected stream URL. 
  // In a real system this could be stored in 'devices' table.
  res.json({
    streamUrl: process.env.ESP32_STREAM_URL || 'http://192.168.1.100:81/stream'
  });
});
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Express REST & WS Server listening on port ${PORT}`);
});
