const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const useragent = require('express-useragent');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 7788;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@SecureVault#2026'; // Default system key (configurable in env)

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(useragent.express());
app.use(session({
  secret: 'vault-session-key-secret-98765',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 60 * 1000 // Session expires in 30 minutes
  }
}));

// Ensure directories exist
const isVercel = process.env.VERCEL || process.env.NOW_BUILDER;
const dataDir = isVercel ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
const uploadsDir = isVercel ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded video files
app.use('/uploads', express.static(uploadsDir));

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// DB File Paths
const videosDbPath = path.join(dataDir, 'videos.json');
const logsDbPath = path.join(dataDir, 'logs.json');
const settingsDbPath = path.join(dataDir, 'settings.json');

// Helper to read JSON DB
function readDb(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf8');
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return [];
  }
}

// Helper to write JSON DB
function writeDb(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err);
  }
}

// Configure Multer for video file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Unique filename: timestamp + original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

// File filter to allow only videos
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only video files are allowed!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100 MB limit
  }
});

// Configure Multer for audio uploads
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const sessionId = req.body.sessionId || 'unknown';
    cb(null, `audio-${sessionId}.webm`);
  }
});

const uploadAudio = multer({
  storage: audioStorage,
  limits: {
    fileSize: 15 * 1024 * 1024 // 15 MB limit
  }
});

// Authentication Middleware to protect sensitive administrative endpoints
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'System unauthorized. Mount key required.' });
  }
};

/* ==========================================================================
   AUTH SYSTEM ENDPOINTS
   ========================================================================== */

// Check current session state
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.sendStatus(200);
  } else {
    res.sendStatus(401);
  }
});

// Authenticate session password
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.status(200).json({ message: 'System unlocked.' });
  } else {
    res.status(401).json({ error: 'Incorrect system credentials.' });
  }
});

// Destroy session (Logout)
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Locking failed.' });
    res.status(200).json({ message: 'System locked.' });
  });
});

/* ==========================================================================
   VIDEO ROUTES
   ========================================================================== */

// Get all videos (Publicly readable)
app.get('/api/videos', (req, res) => {
  const videos = readDb(videosDbPath);
  res.json(videos);
});

// Upload a new video (Admin protected)
app.post('/api/upload', requireAuth, upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided or file type not allowed.' });
    }

    const { title, category, description } = req.body;
    if (!title) {
      // Remove file if title is missing
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Title is required.' });
    }

    const videos = readDb(videosDbPath);
    const newVideo = {
      id: Date.now().toString(),
      title: title.trim(),
      category: (category || 'General').trim(),
      description: (description || '').trim(),
      filename: req.file.filename,
      filepath: `/uploads/${req.file.filename}`,
      size: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date().toISOString()
    };

    videos.unshift(newVideo); // Add to beginning of list
    writeDb(videosDbPath, videos);

    res.status(201).json({ message: 'Video uploaded successfully!', video: newVideo });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload video.' });
  }
});

// Delete a video (Admin protected)
app.delete('/api/videos/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let videos = readDb(videosDbPath);
    const index = videos.findIndex(v => v.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Video not found.' });
    }

    const video = videos[index];
    const filePath = path.join(uploadsDir, video.filename);

    // Delete file from disk
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from DB
    videos.splice(index, 1);
    writeDb(videosDbPath, videos);

    res.json({ message: 'Video deleted successfully!' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete video.' });
  }
});

/* ==========================================================================
   TRACKER / LOGS ROUTES
   ========================================================================== */

// Get all visitor logs (Admin protected)
app.get('/api/logs', requireAuth, (req, res) => {
  const logs = readDb(logsDbPath);
  res.json(logs);
});

// Post a new visitor log (Public endpoint for logging)
app.post('/api/log-visit', (req, res) => {
  try {
    const {
      id, // Session ID generated by client
      ip,
      city,
      region,
      country,
      country_code,
      isp,
      latitude,
      longitude,
      timezone,
      page,
      ua,
      device
    } = req.body;

    // Parse client IP considering reverse proxies (e.g. Render/Cloudflare)
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ip;
    if (clientIp && clientIp.includes(',')) {
      clientIp = clientIp.split(',')[0].trim(); // Get the first IP in the proxy list (actual visitor IP)
    }
    if (clientIp === '::1' || clientIp === '127.0.0.1') {
      clientIp = ip || 'Localhost (127.0.0.1)';
    }

    // Parse browser info from user agent string
    let browserInfo = 'Unknown';
    if (req.useragent) {
      const b = req.useragent;
      const browserName = b.isEdge ? 'Edge' : 
                          b.isChrome ? 'Chrome' : 
                          b.isFirefox ? 'Firefox' : 
                          b.isSafari ? 'Safari' : 
                          b.isOpera ? 'Opera' : 
                          b.isIE ? 'Internet Explorer' : b.browser;
      const osName = b.os || 'Unknown OS';
      const version = b.version || '';
      browserInfo = `${browserName} ${version} on ${osName}`;
    } else {
      browserInfo = ua || req.headers['user-agent'] || 'Unknown';
    }

    const logs = readDb(logsDbPath);
    const existingIndex = logs.findIndex(l => l.id === id);

    if (existingIndex !== -1) {
      // Update coordinates and reverse geocoded details of existing live tracker session
      logs[existingIndex].latitude = latitude !== undefined && latitude !== null ? latitude : logs[existingIndex].latitude;
      logs[existingIndex].longitude = longitude !== undefined && longitude !== null ? longitude : logs[existingIndex].longitude;
      logs[existingIndex].city = city || logs[existingIndex].city;
      logs[existingIndex].region = region || logs[existingIndex].region;
      logs[existingIndex].country = country || logs[existingIndex].country;
      logs[existingIndex].country_code = country_code || logs[existingIndex].country_code;
      logs[existingIndex].device = device || logs[existingIndex].device;
      logs[existingIndex].timestamp = new Date().toISOString(); // Update timestamp to show live motion time
      writeDb(logsDbPath, logs);
      return res.status(200).json({ message: 'Visit updated successfully.' });
    }

    // Otherwise create new log record
    const newLog = {
      id: id || Date.now().toString(),
      timestamp: new Date().toISOString(),
      ip: clientIp,
      city: city || 'Unknown',
      region: region || 'Unknown',
      country: country || 'Unknown',
      country_code: country_code || '',
      isp: isp || 'Unknown',
      latitude: latitude || null,
      longitude: longitude || null,
      timezone: timezone || 'Unknown',
      page: page || '/',
      ua: browserInfo,
      device: device || 'PC/Desktop'
    };

    logs.unshift(newLog); // Newest logs first
    if (logs.length > 1000) {
      logs.length = 1000; // Cap at 1000 logs
    }
    writeDb(logsDbPath, logs);

    res.status(201).json({ message: 'Visit logged successfully.' });
  } catch (err) {
    console.error('Visit logging error:', err);
    res.status(500).json({ error: 'Failed to log visit.' });
  }
});

/* ==========================================================================
   SETTINGS & AUDIO ENDPOINTS
   ========================================================================== */

// Get settings configuration
app.get('/api/settings', (req, res) => {
  try {
    if (!fs.existsSync(settingsDbPath)) {
      const defaultSettings = { microphoneEnabled: false };
      fs.writeFileSync(settingsDbPath, JSON.stringify(defaultSettings, null, 2), 'utf8');
      return res.json(defaultSettings);
    }
    const data = fs.readFileSync(settingsDbPath, 'utf8');
    return res.json(JSON.parse(data || '{"microphoneEnabled":false}'));
  } catch (err) {
    res.json({ microphoneEnabled: false });
  }
});

// Update settings configuration (Admin protected)
app.post('/api/settings', requireAuth, (req, res) => {
  try {
    const { microphoneEnabled } = req.body;
    const settings = {
      microphoneEnabled: !!microphoneEnabled
    };
    fs.writeFileSync(settingsDbPath, JSON.stringify(settings, null, 2), 'utf8');
    res.json({ message: 'Settings updated successfully.', settings });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// Upload and link audio to visitor log
app.post('/api/upload-audio', uploadAudio.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }
    const sessionId = req.body.sessionId;
    if (!sessionId) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: 'Session ID is required.' });
    }

    const logs = readDb(logsDbPath);
    const index = logs.findIndex(l => l.id === sessionId);

    if (index === -1) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: 'Visit session not found.' });
    }

    // Link the audio file URL to the log object
    logs[index].audioUrl = `/uploads/${req.file.filename}`;
    writeDb(logsDbPath, logs);

    res.status(200).json({
      message: 'Audio captured and saved successfully.',
      audioUrl: logs[index].audioUrl
    });
  } catch (err) {
    console.error('Audio upload error:', err);
    res.status(500).json({ error: 'Failed to save audio capture.' });
  }
});

// Clear all logs (Admin protected)
app.delete('/api/logs', requireAuth, (req, res) => {
  try {
    writeDb(logsDbPath, []);
    res.json({ message: 'Logs cleared successfully.' });
  } catch (err) {
    console.error('Clear logs error:', err);
    res.status(500).json({ error: 'Failed to clear logs.' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` EduStream Video & Tracker Server Active`);
  console.log(` Running on: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
