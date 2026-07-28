import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import crypto from 'crypto';
import { spawn } from 'child_process';

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
app.post(['/detect', '/api/detect'], express.raw({ type: '*/*', limit: '10mb' }));
app.use(express.json());

// Create uploads directory if not exists
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files & public static files
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/enroll', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'enroll.html'));
});

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

// Helper to determine real-time device online/offline status based on 90s heartbeat window
async function getDeviceConnectivityStatus(maxAgeSeconds = 90) {
  if (!db) {
    return { isOnline: false, status: 'offline', lastHeartbeat: null, secondsAgo: null, source: 'none' };
  }

  try {
    const maxAgeMs = maxAgeSeconds * 1000;
    const now = Date.now();
    let newestTimestampMs = 0;
    let newestIsoString = null;
    let source = 'none';

    // 1. Check devices table for last_heartbeat
    const deviceRow = await db.get('SELECT last_heartbeat FROM devices ORDER BY id LIMIT 1');
    if (deviceRow && deviceRow.last_heartbeat) {
      const tsMs = new Date(deviceRow.last_heartbeat).getTime();
      if (!isNaN(tsMs) && tsMs > newestTimestampMs) {
        newestTimestampMs = tsMs;
        newestIsoString = deviceRow.last_heartbeat;
        source = 'devices.last_heartbeat';
      }
    }

    // 2. Check events table for camera_online, heartbeat, or recent events
    const eventRow = await db.get(
      `SELECT timestamp, detection_type FROM events 
       WHERE detection_type = 'camera_online' 
          OR detection_type LIKE '%online%' 
          OR detection_type LIKE '%heartbeat%'
       ORDER BY id DESC LIMIT 1`
    );

    if (eventRow && eventRow.timestamp) {
      const tsMs = new Date(eventRow.timestamp).getTime();
      if (!isNaN(tsMs) && tsMs > newestTimestampMs) {
        newestTimestampMs = tsMs;
        newestIsoString = eventRow.timestamp;
        source = `events (${eventRow.detection_type})`;
      }
    }

    // 3. Fallback: check most recent event in events table
    if (newestTimestampMs === 0) {
      const anyEvent = await db.get('SELECT timestamp, detection_type FROM events ORDER BY id DESC LIMIT 1');
      if (anyEvent && anyEvent.timestamp) {
        const tsMs = new Date(anyEvent.timestamp).getTime();
        if (!isNaN(tsMs) && tsMs > newestTimestampMs) {
          newestTimestampMs = tsMs;
          newestIsoString = anyEvent.timestamp;
          source = `events fallback (${anyEvent.detection_type})`;
        }
      }
    }

    const isOnline = (newestTimestampMs > 0) && ((now - newestTimestampMs) <= maxAgeMs);
    const status = isOnline ? 'online' : 'offline';

    return {
      isOnline,
      status,
      lastHeartbeat: newestIsoString || new Date(now).toISOString(),
      lastHeartbeatMs: newestTimestampMs,
      secondsAgo: newestTimestampMs > 0 ? Math.round((now - newestTimestampMs) / 1000) : null,
      source
    };
  } catch (err) {
    console.error('Error computing device connectivity status:', err);
    return { isOnline: false, status: 'offline', lastHeartbeat: null, secondsAgo: null, source: 'error' };
  }
}

async function formatDeviceObject(device) {
  const connectivity = await getDeviceConnectivityStatus(90);
  const streamUrl = (device && device.stream_url) ? device.stream_url : (process.env.ESP32_STREAM_URL || 'http://10.14.51.170/cam-hi.jpg');

  const baseDevice = device || {
    id: 'ESP32-FG-001',
    name: 'Main Farm ESP32 Gatekeeper',
    is_armed: 1,
    battery_level: 87,
    signal_strength: 4
  };

  return {
    ...baseDevice,
    is_armed: baseDevice.is_armed ? 1 : 0,
    isArmed: Boolean(baseDevice.is_armed),
    armed: Boolean(baseDevice.is_armed),
    battery_level: baseDevice.battery_level || 87,
    batteryLevel: baseDevice.battery_level || 87,
    signal_strength: baseDevice.signal_strength || 4,
    signalStrength: baseDevice.signal_strength || 4,
    is_online: connectivity.isOnline,
    isOnline: connectivity.isOnline,
    status: connectivity.status,
    online: connectivity.isOnline,
    last_heartbeat: connectivity.lastHeartbeat,
    lastHeartbeat: connectivity.lastHeartbeat,
    seconds_since_last_heartbeat: connectivity.secondsAgo,
    stream_url: streamUrl,
    streamUrl: streamUrl
  };
}

async function sendSystemStatus(ws) {
  try {
    const rawDevice = await db.get('SELECT * FROM devices LIMIT 1');
    const device = await formatDeviceObject(rawDevice);
    const recentEvents = await db.all('SELECT * FROM events ORDER BY timestamp DESC LIMIT 20');
    const response = {
      type: 'STATUS_UPDATE',
      device,
      status: device,
      events: recentEvents,
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
  const connectivity = await getDeviceConnectivityStatus(90);
  const isOnline = connectivity.isOnline;

  const healthData = {
    status: connectivity.status,
    isOnline: connectivity.isOnline,
    online: connectivity.isOnline,
    service: 'FarmGuard Gateway API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected',
    last_heartbeat: connectivity.lastHeartbeat,
    seconds_since_last_heartbeat: connectivity.secondsAgo,
    heartbeat_source: connectivity.source
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
          .red { color: #ef4444; }
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
            <div class="badge">
              <span class="pulse"></span>
              <span>API ONLINE</span>
            </div>
          </div>
          <div class="grid">
            <div class="item">
              <span class="label">ESP32 Device</span>
              <span class="value ${isOnline ? 'green' : 'red'}">${isOnline ? 'CONNECTED' : 'DISCONNECTED'}</span>
            </div>
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

// Flexible authentication middleware: accepts JWT Token OR x-api-key OR query api_key OR GET request
const authenticateTokenOrApiKey = (req, res, next) => {
  const deviceKey = req.headers['x-api-key'] || req.headers['api-key'] || req.headers['x-device-key'] || req.query.api_key || req.body?.api_key;
  const configuredKey = process.env.DEVICE_API_KEY || 'secure_esp32_device_shared_api_key_2026';
  
  if (deviceKey && deviceKey === configuredKey) {
    req.user = { id: 0, username: 'esp32_device', role: 'owner' };
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) {
        req.user = user;
        return next();
      }
    });
  }

  // Allow GET requests for mobile apps / dashboards
  if (req.method === 'GET') {
    return next();
  }

  return res.status(401).json({ error: 'Access token or API key required' });
};

// ESP32 Shared Key verification middleware
const verifyDeviceApiKey = (req, res, next) => {
  const deviceKey = req.headers['x-api-key'] || req.headers['api-key'] || req.headers['x-device-key'] || req.query.api_key || req.body?.api_key;
  const configuredKey = process.env.DEVICE_API_KEY || 'secure_esp32_device_shared_api_key_2026';
  
  if (!deviceKey || deviceKey !== configuredKey) {
    console.warn(`[DEVICE KEY REJECTED] IP: ${req.ip}, Path: ${req.path}, Key: ${deviceKey}`);
    return res.status(403).json({ error: 'Unauthorized device key access' });
  }
  next();
};

// Embedded Python AI Service Process Launcher
const AI_PORT = process.env.AI_SERVICE_PORT || 5001;
let aiProcess = null;

function startEmbeddedAIService() {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const mainPort = process.env.PORT || 5000;
  console.log(`[AI SERVICE] Spawning embedded Python AI detection microservice on port ${AI_PORT}...`);

  try {
    aiProcess = spawn(pythonCmd, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(AI_PORT)], {
      cwd: path.join(__dirname, 'ai-service'),
      env: {
        ...process.env,
        PORT: String(AI_PORT),
        MAIN_PORT: String(mainPort),
        BACKEND_EVENT_URL: process.env.BACKEND_EVENT_URL || `http://127.0.0.1:${mainPort}/api/device/event`
      },
      stdio: 'inherit'
    });

    aiProcess.on('error', (err) => {
      console.warn('[AI SERVICE WARNING] Could not start Python AI service:', err.message);
    });

    aiProcess.on('exit', (code, signal) => {
      console.warn(`[AI SERVICE] Python AI service process exited (code: ${code}, signal: ${signal})`);
    });
  } catch (err) {
    console.warn('[AI SERVICE ERROR] Failed to spawn AI process:', err.message);
  }
}

startEmbeddedAIService();

// In-memory JPEG frame buffer for latest frame fallback
let globalLatestFrameBuffer = null;

// AI Detection Endpoints
app.get(['/detect', '/api/detect'], (req, res) => {
  res.json({
    service: "FarmGuard AI Object Detection API",
    status: "active",
    message: "This detection endpoint receives POST requests containing JPEG binary image payloads.",
    instructions: {
      method: "POST",
      endpoint: "/detect",
      headers: {
        "x-api-key": "secure_esp32_device_shared_api_key_2026",
        "Content-Type": "image/jpeg"
      },
      body: "<raw JPEG image bytes>"
    }
  });
});

app.post(['/detect', '/api/detect'], verifyDeviceApiKey, async (req, res) => {
  try {
    const rawImageBuffer = Buffer.isBuffer(req.body) ? req.body : (req.body ? Buffer.from(req.body) : null);
    if (!rawImageBuffer || rawImageBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty JPEG image request body' });
    }

    // Cache latest raw JPEG in memory
    globalLatestFrameBuffer = rawImageBuffer;

    const aiUrl = process.env.AI_SERVICE_URL || `http://127.0.0.1:${AI_PORT}/detect`;
    
    try {
      const response = await fetch(aiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'x-api-key': req.headers['x-api-key'] || 'secure_esp32_device_shared_api_key_2026'
        },
        body: rawImageBuffer
      });

      if (response.ok) {
        const data = await response.json();
        
        // Try fetching updated annotated frame from AI service
        try {
          const frameRes = await fetch(aiUrl.replace('/detect', '/latest-frame'));
          if (frameRes.ok) {
            const arrBuf = await frameRes.arrayBuffer();
            globalLatestFrameBuffer = Buffer.from(arrBuf);
          }
        } catch (e) {}

        return res.status(200).json(data);
      }
    } catch (err) {
      // AI service not ready yet, return successful reception response
    }

    return res.status(200).json({
      status: "success",
      message: "Frame received and stored in memory buffer",
      detections: [],
      count: 0
    });
  } catch (err) {
    console.error('Error handling /detect:', err.message);
    return res.status(500).json({ error: 'Failed to process detection request' });
  }
});

app.get(['/latest-frame', '/api/latest-frame'], async (req, res) => {
  if (globalLatestFrameBuffer && globalLatestFrameBuffer.length > 0) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(globalLatestFrameBuffer);
  }

  // Try requesting from AI microservice if set
  const aiFrameUrl = (process.env.AI_SERVICE_URL ? process.env.AI_SERVICE_URL + '/latest-frame' : `http://127.0.0.1:${AI_PORT}/latest-frame`);
  try {
    const response = await fetch(aiFrameUrl);
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      const imgBuffer = Buffer.from(buffer);
      globalLatestFrameBuffer = imgBuffer;
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(imgBuffer);
    }
  } catch (err) {}

  return res.status(404).json({ 
    error: 'No frame captured yet. Send a POST /detect request with JPEG image payload first.' 
  });
});


// Global helper to update ESP32 device status & heartbeat on ANY request
async function updateDeviceHeartbeat(req, extraData = {}) {
  if (!db) return null;
  try {
    const ts = new Date().toISOString();
    const deviceId = req.body?.device_id || extraData?.device_id || 'ESP32-FG-001';
    const battery = req.body?.battery_level ?? extraData?.battery_level ?? null;
    const signal = req.body?.signal_strength ?? extraData?.signal_strength ?? null;
    const isArmed = req.body?.is_armed !== undefined ? (req.body.is_armed ? 1 : 0) : null;
    
    // Extract IP or stream URL from request or payload if provided
    let streamUrl = req.body?.stream_url || req.body?.cam_url || extraData?.stream_url || null;
    const clientIp = req.body?.ip || req.body?.ip_address || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    if (!streamUrl && clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') {
      const cleanIp = clientIp.replace(/^.*:/, '');
      if (cleanIp && cleanIp !== 'localhost') {
        streamUrl = `http://${cleanIp}/cam-hi.jpg`;
      }
    }

    const existing = await db.get('SELECT * FROM devices WHERE id = ? OR id = "ESP32-FG-001" LIMIT 1', [deviceId]);
    if (existing) {
      await db.run(
        `UPDATE devices 
         SET last_heartbeat = ?, 
             battery_level = COALESCE(?, battery_level), 
             signal_strength = COALESCE(?, signal_strength),
             is_armed = COALESCE(?, is_armed),
             stream_url = COALESCE(?, stream_url)
         WHERE id = ?`,
        [ts, battery, signal, isArmed, streamUrl, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO devices (id, name, is_armed, battery_level, signal_strength, last_heartbeat, stream_url) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [deviceId, 'ESP32 Security Node', isArmed !== null ? isArmed : 1, battery || 100, signal || 5, ts, streamUrl || 'http://10.14.51.170/cam-hi.jpg']
      );
    }

    const rawDevice = await db.get('SELECT * FROM devices WHERE id = ? OR id = "ESP32-FG-001" LIMIT 1', [deviceId]);
    const updatedDevice = formatDeviceObject(rawDevice);

    // Broadcast updated heartbeat status to all connected dashboards & mobile apps
    broadcast({
      type: 'DEVICE_HEARTBEAT',
      device: updatedDevice,
      status: updatedDevice
    });
    broadcast({
      type: 'STATUS_UPDATE',
      device: updatedDevice,
      status: updatedDevice
    });

    return updatedDevice;
  } catch (err) {
    console.error('Error updating device heartbeat:', err);
    return null;
  }
}

// Login Route
let currentStreamUrl = null;
let abortController = null;

function broadcastBinary(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

async function startCameraProxy(url) {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  
  currentStreamUrl = url;
  if (!url) return;

  abortController = new AbortController();

  try {
    const response = await fetch(url, {
      headers: { 
        'Bypass-Tunnel-Reminder': 'true',
        'ngrok-skip-browser-warning': 'true'
      },
      signal: abortController.signal,
      redirect: 'follow'
    });

    if (!response.ok) {
      console.error(`Camera proxy HTTP error: ${response.status} ${response.statusText}`);
      setTimeout(() => startCameraProxy(currentStreamUrl), 5000);
      return;
    }

    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('Camera proxy stream ended.');
        break;
      }

      let newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Extract ALL complete frames from the current buffer
      while (true) {
        let start = -1;
        let end = -1;
        
        for (let i = 0; i < buffer.length - 1; i++) {
          if (buffer[i] === 0xff && buffer[i+1] === 0xd8 && start === -1) start = i;
          if (buffer[i] === 0xff && buffer[i+1] === 0xd9 && start !== -1) {
            end = i + 2;
            break;
          }
        }

        if (start !== -1 && end !== -1 && end > start) {
          const frame = buffer.slice(start, end);
          broadcastBinary(frame);
          buffer = buffer.slice(end);
        } else if (start === -1 && buffer.length > 0) {
          // No start marker found. Discard junk data, keep last byte just in case it's 0xff
          buffer = buffer.slice(buffer.length - 1);
          break;
        } else {
          break; // Start found, but end not found yet. Wait for more data.
        }
      }
    }

    setTimeout(() => startCameraProxy(currentStreamUrl), 5000);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to start camera proxy:', err.message);
      setTimeout(() => startCameraProxy(currentStreamUrl), 5000);
    }
  }
}

// Ensure proxy starts on boot
db.get('SELECT stream_url FROM devices LIMIT 1').then(device => {
  if (device && device.stream_url) {
    startCameraProxy(device.stream_url);
  }
}).catch(err => console.error(err));

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
app.get('/api/events', authenticateTokenOrApiKey, async (req, res) => {
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

  // Refresh ESP32 heartbeat timestamp and IP status
  await updateDeviceHeartbeat(req);

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
app.get('/api/device/status', authenticateTokenOrApiKey, async (req, res) => {
  try {
    const rawDevice = await db.get('SELECT * FROM devices LIMIT 1');
    const device = await formatDeviceObject(rawDevice);
    res.json(device);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve device status' });
  }
});

app.post('/api/device/status', verifyDeviceApiKey, async (req, res) => {
  try {
    const updatedDevice = await updateDeviceHeartbeat(req);
    res.status(201).json({ success: true, device: updatedDevice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post device status' });
  }
});

// Explicit Heartbeat Endpoint for ESP32
app.post('/api/device/heartbeat', verifyDeviceApiKey, async (req, res) => {
  try {
    const updatedDevice = await updateDeviceHeartbeat(req);
    res.status(201).json({
      success: true,
      message: 'Heartbeat received',
      device: updatedDevice
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record heartbeat' });
  }
});

// Ping Endpoint for ESP32
app.post('/api/device/ping', verifyDeviceApiKey, async (req, res) => {
  try {
    const updatedDevice = await updateDeviceHeartbeat(req);
    res.status(201).json({
      success: true,
      message: 'Pong',
      device: updatedDevice
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record ping' });
  }
});

// Universal Arm/Disarm Toggle Handler
async function handleArmToggle(req, res) {
  try {
    let targetArmedState = null;

    // Check all common payload keys (is_armed, isArmed, armed, arm, state, action)
    const body = req.body || {};
    const val = body.is_armed ?? body.isArmed ?? body.armed ?? body.arm ?? body.state ?? body.action;

    if (val !== undefined && val !== null) {
      if (typeof val === 'boolean') {
        targetArmedState = val ? 1 : 0;
      } else if (typeof val === 'number') {
        targetArmedState = val > 0 ? 1 : 0;
      } else if (typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        if (['true', '1', 'arm', 'armed', 'enable', 'on'].includes(lower)) {
          targetArmedState = 1;
        } else if (['false', '0', 'disarm', 'disarmed', 'disable', 'off'].includes(lower)) {
          targetArmedState = 0;
        }
      }
    }

    // If no explicit value provided (e.g. empty POST), automatically toggle current state
    if (targetArmedState === null) {
      const current = await db.get('SELECT is_armed FROM devices LIMIT 1');
      const currentVal = current ? (current.is_armed ? 1 : 0) : 0;
      targetArmedState = currentVal ? 0 : 1;
    }

    // Update database & refresh last_heartbeat so device stays connected/online on toggle
    const ts = new Date().toISOString();
    await db.run('UPDATE devices SET is_armed = ?, last_heartbeat = ?', [targetArmedState, ts]);

    const rawDevice = await db.get('SELECT * FROM devices LIMIT 1');
    const formattedDevice = await formatDeviceObject(rawDevice);

    const updatedDevice = {
      ...formattedDevice,
      is_armed: targetArmedState,
      isArmed: Boolean(targetArmedState),
      armed: Boolean(targetArmedState),
      arm_status: targetArmedState ? 'ARMED' : 'DISARMED',
      arm_color: targetArmedState ? '#10b981' : '#ef4444',
      is_online: true,
      isOnline: true,
      status: 'online',
      online: true
    };

    // Broadcast updated arm & heartbeat status over WebSockets to all connected clients
    broadcast({
      type: 'STATUS_UPDATE',
      device: updatedDevice,
      status: updatedDevice
    });
    broadcast({
      type: 'DEVICE_HEARTBEAT',
      device: updatedDevice,
      status: updatedDevice
    });
    broadcast({
      type: 'ARM_STATUS_CHANGED',
      is_armed: updatedDevice.is_armed,
      isArmed: updatedDevice.isArmed,
      armed: updatedDevice.armed,
      arm_status: updatedDevice.arm_status,
      arm_color: updatedDevice.arm_color,
      device: updatedDevice
    });

    res.status(200).json({
      success: true,
      message: `System ${targetArmedState ? 'ARMED' : 'DISARMED'} successfully`,
      is_armed: updatedDevice.is_armed,
      isArmed: updatedDevice.isArmed,
      armed: updatedDevice.armed,
      arm_status: updatedDevice.arm_status,
      arm_color: updatedDevice.arm_color,
      is_online: true,
      isOnline: true,
      status: 'online',
      device: updatedDevice
    });
  } catch (err) {
    console.error('Error toggling arm state:', err);
    res.status(500).json({ error: 'Failed to toggle arm state' });
  }
}

// Registered Arm/Disarm Endpoint Routes
app.post('/api/device/arm-toggle', authenticateTokenOrApiKey, handleArmToggle);
app.post('/api/device/arm_toggle', authenticateTokenOrApiKey, handleArmToggle);
app.post('/api/device/toggle-arm', authenticateTokenOrApiKey, handleArmToggle);
app.post('/api/device/arm', authenticateTokenOrApiKey, (req, res) => {
  req.body = { ...req.body, is_armed: true };
  handleArmToggle(req, res);
});
app.post('/api/device/disarm', authenticateTokenOrApiKey, (req, res) => {
  req.body = { ...req.body, is_armed: false };
  handleArmToggle(req, res);
});

// Update Stream URL endpoint for web dashboard
app.post('/api/device/stream-url', authenticateToken, async (req, res) => {
  const { stream_url } = req.body;
  if (stream_url === undefined) return res.status(400).json({ error: 'stream_url required' });

  try {
    await db.run('UPDATE devices SET stream_url = ?', [stream_url]);
    
    const updatedDevice = await db.get('SELECT * FROM devices LIMIT 1');
    
    // Restart proxy with new URL
    startCameraProxy(stream_url);

    // Broadcast status change so other devices automatically update their stream view
    broadcast({
      type: 'STATUS_UPDATE',
      device: updatedDevice
    });

    res.json({ success: true, stream_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update stream URL' });
  }
});

// ==========================================
// ESP32 SMART FACE RECOGNITION & RFID APIs
// ==========================================

// 7. Face Management Endpoints

// Enrolled Face Recognition Endpoints (for python script / face access control feature)
app.post('/api/faces/enroll', verifyDeviceApiKey, async (req, res) => {
  const { name, images } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Images array is required and must contain at least one base64 image string' });
  }

  try {
    const ts = new Date().toISOString();
    const personName = name.trim();

    for (const imgData of images) {
      if (typeof imgData === 'string' && imgData.trim().length > 0) {
        await db.run(
          'INSERT INTO enrolled_faces (name, image_data, created_at) VALUES (?, ?, ?)',
          [personName, imgData, ts]
        );
      }
    }

    const result = await db.get('SELECT COUNT(*) as count FROM enrolled_faces WHERE name = ?', [personName]);
    const totalCount = result ? result.count : 0;

    res.status(200).json({
      success: true,
      name: personName,
      count: totalCount,
      message: `Enrolled image(s) for ${personName} stored successfully`
    });
  } catch (err) {
    console.error('Error enrolling face images:', err);
    res.status(500).json({ error: 'Failed to enroll face images' });
  }
});

app.get('/api/faces/list', verifyDeviceApiKey, async (req, res) => {
  try {
    const rows = await db.all('SELECT name, image_data FROM enrolled_faces ORDER BY id ASC');
    
    // Group images by name while maintaining insertion order
    const peopleMap = new Map();
    for (const row of rows) {
      if (!peopleMap.has(row.name)) {
        peopleMap.set(row.name, []);
      }
      peopleMap.get(row.name).push(row.image_data);
    }

    const people = Array.from(peopleMap.entries()).map(([name, images]) => ({
      name,
      images
    }));

    res.status(200).json({ people });
  } catch (err) {
    console.error('Error listing enrolled faces:', err);
    res.status(500).json({ error: 'Failed to list enrolled faces' });
  }
});

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

app.delete('/api/faces/:name', async (req, res) => {
  const deviceKey = req.headers['x-api-key'] || req.query.api_key;
  const configuredKey = process.env.DEVICE_API_KEY || 'secure_esp32_device_shared_api_key_2026';

  if (deviceKey && deviceKey === configuredKey) {
    const { name } = req.params;
    try {
      const result = await db.run('DELETE FROM enrolled_faces WHERE name = ?', [name]);
      return res.status(200).json({
        success: true,
        name,
        deletedCount: result.changes || 0,
        message: `Enrolled faces for ${name} removed successfully`
      });
    } catch (err) {
      console.error('Error deleting enrolled faces:', err);
      return res.status(500).json({ error: 'Failed to delete enrolled faces' });
    }
  }

  // Fallback for JWT dashboard auth (deleting from faces table by ID)
  return authenticateToken(req, res, () => {
    return requireRole(['owner'])(req, res, async () => {
      const { name: id } = req.params;
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
  });
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

    const detection_type = method === 'Face' ? 'Recognized Owner' : 'RFID Scanned';
    await db.run(
      'INSERT INTO events (timestamp, detection_type, zone_name, is_recognized) VALUES (?, ?, ?, ?)',
      [ts, detection_type, 'ESP32 Access Point', 1]
    );

    const log = await db.get('SELECT * FROM events WHERE id = last_insert_rowid()');
    log.person_name = personName;

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

// 11. Live Camera Frame Endpoints (1Hz polling by mobile app & Python script)
const latestLiveFrames = new Map();

app.post('/api/device/live-frame', verifyDeviceApiKey, async (req, res) => {
  const { zone_name, image } = req.body;
  if (!image || typeof image !== 'string' || !image.trim()) {
    return res.status(400).json({ error: 'Image (base64 string) is required' });
  }

  const zoneName = (zone_name && typeof zone_name === 'string' && zone_name.trim()) ? zone_name.trim() : 'Camera-01';
  const timestamp = new Date().toISOString();

  latestLiveFrames.set(zoneName, {
    zone_name: zoneName,
    image: image.trim(),
    timestamp
  });

  res.status(200).json({
    success: true,
    zone_name: zoneName,
    timestamp
  });
});

app.get('/api/device/live-frame', verifyDeviceApiKey, async (req, res) => {
  const zoneName = (req.query.zone_name && typeof req.query.zone_name === 'string' && req.query.zone_name.trim()) 
    ? req.query.zone_name.trim() 
    : 'Camera-01';

  const frameData = latestLiveFrames.get(zoneName);

  if (!frameData) {
    return res.status(200).json({
      status: 'no_frame_yet',
      message: 'No live frame received yet for this zone',
      zone_name: zoneName
    });
  }

  res.status(200).json({
    zone_name: frameData.zone_name,
    image: frameData.image,
    timestamp: frameData.timestamp
  });
});

// 11. Camera Public Proxy Endpoints (Tunnel local ESP32 stream to anywhere via Ngrok)
app.get('/api/camera/stream', async (req, res) => {
  let targetUrl = process.env.ESP32_STREAM_URL || 'http://10.14.51.170:81/stream';
  
  try {
    const dbDevice = await db.get('SELECT stream_url FROM devices WHERE stream_url IS NOT NULL LIMIT 1');
    if (dbDevice && dbDevice.stream_url) {
      targetUrl = dbDevice.stream_url;
    }
  } catch (e) {}

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const response = await fetch(targetUrl, { signal: controller.signal });
    if (!response.ok || !response.body) {
      return res.status(502).send('Camera stream unreachable');
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Error proxying camera stream:', err.message);
    }
    if (!res.headersSent) {
      res.status(502).send('Stream error or camera offline');
    }
  }
});

app.get('/api/camera/snapshot', async (req, res) => {
  const targetUrl = process.env.ESP32_SNAPSHOT_URL || 'http://10.14.51.170/cam-hi.jpg';

  try {
    const response = await fetch(targetUrl);
    if (!response.ok) {
      return res.status(502).json({ error: 'Snapshot unavailable' });
    }

    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Error fetching camera snapshot:', err.message);
    res.status(502).json({ error: 'Snapshot error' });
  }
});

// 12. Camera Stream Config Endpoint
app.get('/api/camera/config', async (req, res) => {
  try {
    const hostHeader = req.headers.host || '';
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const baseUrl = hostHeader ? `${protocol}://${hostHeader}` : '';

    const dbDevice = await db.get('SELECT stream_url FROM devices WHERE stream_url IS NOT NULL LIMIT 1');
    const configuredUrl = (dbDevice && dbDevice.stream_url) ? dbDevice.stream_url : 'http://10.14.51.170:81/stream';

    res.json({
      streamUrl: baseUrl ? `${baseUrl}/api/camera/stream` : '/api/camera/stream',
      snapshotUrl: baseUrl ? `${baseUrl}/api/camera/snapshot` : '/api/camera/snapshot',
      directStreamUrl: configuredUrl,
      directSnapshotUrl: 'http://10.14.51.170/cam-hi.jpg'
    });
  } catch (err) {
    res.json({
      streamUrl: '/api/camera/stream',
      snapshotUrl: '/api/camera/snapshot',
      directStreamUrl: 'http://10.14.51.170:81/stream',
      directSnapshotUrl: 'http://10.14.51.170/cam-hi.jpg'
    });
  }
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Express REST & WS Server listening on http://${HOST}:${PORT}`);
});
