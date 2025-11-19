// Load environment variables in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const session = require('express-session');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Store users and their credentials (in production, use a database)
const users = {
  [process.env.USER_NAME || 'admin']: process.env.USER_PASSWORD || 'password123'
};

// Store WhatsApp clients per user
const clients = {};
let currentQR = null;

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login.html');
  }
}

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (users[username] && users[username] === password) {
    req.session.user = username;
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Invalid credentials' });
  }
});

// Check auth status
app.get('/api/auth-status', (req, res) => {
  res.json({ 
    authenticated: !!req.session.user,
    user: req.session.user 
  });
});

// Initialize WhatsApp client
app.post('/api/init-whatsapp', isAuthenticated, async (req, res) => {
  const user = req.session.user;
  
  // Check if client already exists and is ready
  if (clients[user] && clients[user].info) {
    return res.json({ status: 'ready', needsQR: false });
  }
  
  try {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: user }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    });

    client.on('qr', (qr) => {
      console.log('QR Code received for user:', user);
      currentQR = qr;
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          console.error('Error generating QR code:', err);
        }
      });
    });

    client.on('ready', () => {
      console.log('WhatsApp client ready for user:', user);
      clients[user] = client;
      currentQR = null;
    });

    client.on('authenticated', () => {
      console.log('WhatsApp authenticated for user:', user);
    });

    client.on('auth_failure', (msg) => {
      console.error('Authentication failure:', msg);
      currentQR = null;
    });

    client.initialize();
    clients[user] = client;
    
    res.json({ status: 'initializing', needsQR: true });
  } catch (error) {
    console.error('Error initializing WhatsApp:', error);
    res.status(500).json({ error: 'Failed to initialize WhatsApp' });
  }
});

// Get QR code
app.get('/api/qr', isAuthenticated, async (req, res) => {
  if (currentQR) {
    try {
      const qrImage = await qrcode.toDataURL(currentQR);
      res.json({ qr: qrImage });
    } catch (error) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  } else {
    res.json({ qr: null });
  }
});

// Check WhatsApp status
app.get('/api/whatsapp-status', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const client = clients[user];
  
  if (!client) {
    return res.json({ ready: false, needsQR: true });
  }
  
  if (client.info) {
    return res.json({ ready: true, needsQR: false, info: client.info });
  }
  
  res.json({ ready: false, needsQR: !!currentQR });
});

// Send messages
app.post('/api/send-messages', isAuthenticated, upload.single('numbers'), async (req, res) => {
  const user = req.session.user;
  const client = clients[user];
  
  if (!client || !client.info) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  
  const { message } = req.body;
  const file = req.file;
  
  if (!file || !message) {
    return res.status(400).json({ error: 'Missing message or phone numbers file' });
  }
  
  try {
    const fileContent = fs.readFileSync(file.path, 'utf-8');
    const phoneNumbers = fileContent
      .split('\n')
      .map(num => num.trim())
      .filter(num => num.length > 0);
        
    const results = [];
    
    for (const number of phoneNumbers) {
      try {
        // Format number (remove spaces, dashes, etc.)
        const formattedNumber = number.replace(/[^\d]/g, '');
        // Add country code format if not present
        const chatId = formattedNumber.includes('@') 
          ? formattedNumber 
          : `${formattedNumber}@c.us`;
        
        await client.sendMessage(chatId, message);
        results.push({ number, status: 'sent' });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Error sending to ${number}:`, error);
        results.push({ number, status: 'failed', error: error.message });
      }
    }
    
    // Clean up uploaded file
    fs.unlinkSync(file.path);
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error processing messages:', error);
    res.status(500).json({ error: 'Failed to process messages' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const user = req.session.user;
  
  // Optionally destroy WhatsApp client
  if (clients[user]) {
    clients[user].destroy();
    delete clients[user];
  }
  
  req.session.destroy();
  res.json({ success: true });
});

// Redirect root to login
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/qr.html');
  } else {
    res.redirect('/login.html');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});