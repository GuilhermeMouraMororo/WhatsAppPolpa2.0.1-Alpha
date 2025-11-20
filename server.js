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

// Users database file
const USERS_FILE = 'users.json';

// Initialize users file if it doesn't exist
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}

// Load users from file
function loadUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading users:', error);
    return {};
  }
}

// Save users to file
function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Error saving users:', error);
  }
}

function getRandomInt(max) {
  return Math.floor(Math.random() * max);
}

// Store WhatsApp clients per user
const clients = {};
const userQRCodes = {};

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login.html');
  }
}

// Register endpoint
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, message: 'Nome de usuário e senha requeridos' });
  }
  
  if (username.length < 3) {
    return res.json({ success: false, message: 'O nome de usuário precisa ter ao menos 3 caracteres' });
  }
  
  if (password.length < 6) {
    return res.json({ success: false, message: 'A senha precisa ter ao menos 6 caracteres' });
  }
  
  const users = loadUsers();
  
  if (users[username]) {
    return res.json({ success: false, message: 'O nome de usuário já existe' });
  }
  
  users[username] = password;
  saveUsers(users);
  
  res.json({ success: true, message: 'Conta criada com sucesso!' });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  
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
      console.log('QR Code recebido pelo usuário:', user);
      userQRCodes[user] = qr;
    });

    client.on('ready', () => {
      console.log('WhatsApp client pronto para o usuário:', user);
      clients[user] = client;
      delete userQRCodes[user];
    });

    client.on('authenticated', () => {
      console.log('WhatsApp autenticado para o usuário:', user);
    });

    client.on('auth_failure', (msg) => {
      console.error('Autenticação falhada para o usuário:', user, msg);
      delete userQRCodes[user];
    });

    client.initialize();
    clients[user] = client;
    
    res.json({ status: 'initializing', needsQR: true });
  } catch (error) {
    console.error('Error initializing WhatsApp:', error);
    res.status(500).json({ error: 'Falha ao iniciar WhatsApp' });
  }
});

// Get QR code
app.get('/api/qr', isAuthenticated, async (req, res) => {
  const user = req.session.user;
  const qr = userQRCodes[user];
  
  if (qr) {
    try {
      const qrImage = await qrcode.toDataURL(qr);
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
  
  res.json({ ready: false, needsQR: !!userQRCodes[user] });
});

// Send messages
app.post('/api/send-messages', isAuthenticated, upload.fields([ 
    {name: 'numbers', maxCount: 1},
    {name: 'answeredNumbers', maxCount : 1}
]), async (req, res) => {
  const user = req.session.user;
  const client = clients[user];
  
  if (!client || !client.info) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  
  const { message } = req.body;
  const numbersFile = req.files['numbers'][0];
  const answeredFile = req.files['answeredNumbers'] ? req.files['answeredNumbers'][0] : null;
  
  if (!numbersFile || !message) {
    return res.status(400).json({ error: 'Missing message or phone numbers file' });
  }
  
  try {
    const numbersfileContent = fs.readFileSync(numbersFile.path, 'utf-8');
    const phoneNumbers = numbersfileContent
      .split('\n')
      .map(num => num.trim())
      .filter(num => num.length > 0);

    let numbersToSend = phoneNumbers;

    // DEBUG: Log original numbers
    console.log('Original numbers:', phoneNumbers);

    if (answeredFile) {
      const respondidosContent = fs.readFileSync(answeredFile.path, 'utf-8');
      const respondedNumbers = respondidosContent
        .split('\n')
        .map(num => num.trim())
        .filter(num => num.length > 0)
        .map(num => num.replace(/\D/g, '')); // CLEAN THE ANSWERED NUMBERS TOO!

      // DEBUG: Log answered numbers
      console.log('Answered numbers (cleaned):', respondedNumbers);

      numbersToSend = phoneNumbers.filter(num => {
        const cleanedNum = num.replace(/\D/g, '');
        const shouldSend = !respondedNumbers.includes(cleanedNum);
        
        // DEBUG: Show which numbers are being filtered
        if (!shouldSend) {
          console.log(`Filtering out: ${num} (cleaned: ${cleanedNum})`);
        }
        
        return shouldSend;
      });

      // DEBUG: Log results
      console.log(`After filter - Original: ${phoneNumbers.length}, To send: ${numbersToSend.length}`);
    }

    const results = [];

    for (const number of numbersToSend) {
      try {
        const formattedNumber = number.replace(/\D/g, '');
        const chatId = formattedNumber.includes('@') 
          ? formattedNumber 
          : `${formattedNumber}@c.us`;
        
        await client.sendMessage(chatId, message);
        results.push({ number, status: 'sent' });
        
        await new Promise(resolve => setTimeout(resolve, (20 + getRandomInt(8)) * 1000));
      } catch (error) {
        console.error(`Error sending to ${number}:`, error);
        results.push({ number, status: 'failed', error: error.message });
      }
    }
    
    // Clean up uploaded files
    fs.unlinkSync(numbersFile.path);
    if (answeredFile) {
      fs.unlinkSync(answeredFile.path);
    }
    
    res.json({ 
      success: true, 
      results,
      debug: {
        originalCount: phoneNumbers.length,
        filteredCount: numbersToSend.length,
        removedCount: phoneNumbers.length - numbersToSend.length
      }
    });
  } catch (error) {
    console.error('Error processing messages:', error);
    res.status(500).json({ error: 'Failed to process messages' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const user = req.session.user;
  
  // Don't destroy WhatsApp client on logout (keep session active)
  // If you want to destroy it, uncomment:
  // if (clients[user]) {
  //   clients[user].destroy();
  //   delete clients[user];
  // }
  
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
