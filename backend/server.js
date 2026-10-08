require('dotenv').config();

// Fix DNS for MongoDB SRV - only outside Vercel (Vercel has internal DNS)
if (!process.env.VERCEL) {
  try {
    const dns = require('dns');
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  } catch (e) {
    console.warn('DNS setServers warning:', e.message);
  }
}

const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const logger = require('./services/logger');
const { safeMongoSanitize, xssMiddleware, hppMiddleware } = require('./middleware/sanitize');
const { slowDown } = require('express-slow-down');

const complaintRoutes = require('./routes/complaint');
const authRoutes = require('./routes/auth');
const technicianRoutes = require('./routes/technician');
const KESCORoutes = require('./routes/KESCO');
const chatRoutes = require('./routes/chat');
const geoRoutes = require('./routes/geo');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Trust Railway proxy (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR for express-rate-limit)
app.set('trust proxy', 1);

// --- Ensure uploads directory exists for static serving & multer ---
// Vercel: /var/task is read-only, use /tmp for ephemeral uploads (or skip mkdir)
const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) { console.warn('uploads mkdir warning (vercel read-only?):', e.message); }

// --- Security & parsing middleware ---
// FIX "Failed to fetch" on mobile Chrome: helmet's default crossOriginResourcePolicy: same-origin
// blocks cross-origin fetch (Vercel frontend -> Railway backend). Must be cross-origin or disabled.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use(compression({ threshold: 1024 * 10, filter: (req, res) => !req.path.includes('/health') }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));
app.use(express.urlencoded({ extended: true }));
// Security hardening — installed plugins (best practice)
app.use(safeMongoSanitize()); // NoSQL injection protection (body/params only, safe for Express 5)
try { app.use(xssMiddleware()); } catch (e) { logger.warn('xss-clean init warning: ' + e.message); }
app.use(hppMiddleware()); // Prevent HTTP Parameter Pollution

// CORS: strict allowlist — prevents credential theft, still allows Vercel previews
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/\.vercel\.app$/.test(origin) || /localhost:\d+/.test(origin) || /127\.0\.0\.1/.test(origin)) return cb(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie'],
  credentials: true,
}));

// Rate limiting — split for polling vs auth to prevent lag on shared NAT
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
  skip: (req) => req.path === '/api/health' || req.path.startsWith('/socket.io') || req.path.includes('/kesco/') || req.path.includes('/technician/') || req.path.includes('/geo/') || req.path === '/api/complaints/my',
});
const pollingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many polling requests, please wait.' },
});
const sendOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many OTP requests, please wait a few minutes and try again.' }
});

app.use('/api/', generalLimiter);
app.use('/api/kesco/', pollingLimiter);
app.use('/api/technician/', pollingLimiter);
app.use('/api/geo/', pollingLimiter);
// Scope OTP rate limit to send-otp only — verify-otp/profile must not consume the
// budget (shared mobile NAT + resend taps previously locked users out with 429)
app.use('/api/auth/', (req, res, next) => {
  if (req.path.includes('send-otp')) return sendOtpLimiter(req, res, next);
  next();
});

// --- Health check & root ---
app.get('/api/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    success: true,
    status: 'ok',
    mongoState: states[mongoose.connection.readyState] || mongoose.connection.readyState,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
app.get('/', (req, res) => {
  res.json({ success: true, message: 'BijliSathi API running', docs: '/api/health' });
});

// --- Routes ---
app.use('/api/complaints', complaintRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/technician', technicianRoutes);
app.use('/api/kesco', KESCORoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/geo', geoRoutes);

// Static uploads - use uploadsDir (handles Vercel /tmp)
app.use('/uploads', express.static(uploadsDir));

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.originalUrl} not found` });
});

// --- Central error handler (must be after routes) ---
app.use(errorHandler);

// --- Socket.IO ---
const server = http.createServer(app);

let io;
try {
  io = socketIO(server, {
    cors: {
      origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:3000', 'http://localhost:5173'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
} catch (e) {
  console.warn('Socket.IO initialization warning:', e.message);
  io = { emit: () => {}, on: () => {}, to: () => ({ emit: () => {} }) };
}

// Make io accessible via req.app.get('io')
app.set('io', io);

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Join complaint room for targeted updates (citizen tracking)
  socket.on('join-complaint', (complaintId) => {
    if (complaintId) {
      socket.join(complaintId);
      console.log(`Socket ${socket.id} joined room ${complaintId}`);
    }
  });

  // Technician / KESCO personal rooms for Meet calls
  socket.on('join-technician', (technicianId) => {
    if (technicianId) {
      const room = `technician:${technicianId}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined technician room ${room}`);
    }
  });
  socket.on('join-kesco', (kescoId) => {
    if (kescoId) {
      const room = `kesco:${kescoId}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined kesco room ${room}`);
    }
  });

  // Legacy: update-location -> broadcast
  socket.on('update-location', (data) => {
    io.emit('technician-location', data);
  });

  // Technician share-location via socket as well
  socket.on('technician-location', (data) => {
    if (data && data.complaintId) {
      io.to(data.complaintId).emit('technician-location', data);
    }
    io.emit('technician-location-broadcast', data);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

// --- MongoDB connection (proper async handling) ---
let mongoConnected = false;
let lastMongoError = null;

// Handle case where shell env MONGO_URI overrides .env file with stale/wrong cluster
// Prefer file's URI if env var points to known bad cluster (virs09m) or is empty
let effectiveMongoUri = process.env.MONGO_URI;
if (effectiveMongoUri && effectiveMongoUri.includes('virs09m')) {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const match = envFile.match(/MONGO_URI\s*=\s*(.+)/);
    if (match) {
      const fileUri = match[1].trim();
      if (fileUri && !fileUri.includes('virs09m') && fileUri.includes('mongodb')) {
        console.warn('Detected stale MONGO_URI in shell env (virs09m), overriding with .env file value (tacqt1y)');
        effectiveMongoUri = fileUri;
        process.env.MONGO_URI = fileUri;
      }
    }
  } catch {}
}

if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === 'your_cloud_name') {
  // Check if Railway Volume is mounted at /app/uploads (persistent) vs ephemeral
  const volumeMounted = fs.existsSync('/var/lib/containers/railwayapp/bind-mounts') || process.env.RAILWAY_VOLUME_MOUNT_PATH === '/app/uploads' || fs.existsSync(uploadsDir);
  if (volumeMounted) {
    console.log('Using Railway Volume at /app/uploads (500MB Ready) - photos persistent without Cloudinary. Increase to 1GB in Dashboard -> Volumes if needed.');
  } else {
    console.warn('WARNING: CLOUDINARY not configured - complaint photos will use ephemeral local /uploads (lost on Railway redeploy). Railway Volume at /app/uploads is recommended (500MB free) or set CLOUDINARY_* for external storage.');
  }
}
if (!effectiveMongoUri) {
  console.warn('WARNING: MONGO_URI not set in .env - DB features will fail');
} else {
  mongoose.connect(effectiveMongoUri, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    retryWrites: true,
  })
    .then(() => {
      console.log('MongoDB connected');
      mongoConnected = true;
      lastMongoError = null;
    })
    .catch((err) => {
      console.error('MongoDB initial connection error:', err.message);
      lastMongoError = err.message;
      mongoConnected = false;
    });
}

mongoose.connection.on('error', (err) => {
  console.warn('MongoDB connection error:', err.message);
  lastMongoError = err.message;
  mongoConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected');
  mongoConnected = false;
});

mongoose.connection.once('open', () => {
  console.log('MongoDB connection open');
  mongoConnected = true;
});

const PORT = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (!mongoConnected && mongoose.connection.readyState !== 1) {
      console.warn('WARNING: Running without MongoDB connection - some features will be limited (will retry in background)');
    }
    console.log(`Health check: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.io = io;
