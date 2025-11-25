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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Increase timeout for long-running requests
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
  next();
});

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
const activeSessions = {}; // Track active sending sessions

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login.html');
  }
}

// WhatsApp client health check
function isClientHealthy(client) {
  return client && 
         client.pupPage && 
         !client.pupPage.isClosed() && 
         client.info;
}

// Retry mechanism with exponential backoff
async function retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        break;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay + getRandomInt(1000)));
    }
  }
  
  throw lastError;
}

// Safe message sending with recovery
async function safeSendMessage(client, chatId, message, maxRetries = 2) {
  return await retryOperation(async () => {
    // Check client health before sending
    if (!isClientHealthy(client)) {
      throw new Error('WhatsApp client is not healthy');
    }
    
    return await client.sendMessage(chatId, message);
  }, maxRetries, 2000);
}

// Keep-alive mechanism to prevent timeouts
function setupKeepAlive(res) {
  // Send periodic keep-alive headers
  const keepAliveInterval = setInterval(() => {
    if (!res.headersSent) {
      res.write(' '); // Send empty space to keep connection alive
    }
  }, 30000); // Every 30 seconds

  return () => clearInterval(keepAliveInterval);
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
    res.json({ success: false, message: 'Credenciais inválidas' });
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
  if (clients[user] && isClientHealthy(clients[user])) {
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
          '--disable-gpu',
          '--max-old-space-size=512'
        ],
        timeout: 60000
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

    client.on('disconnected', (reason) => {
      console.log('WhatsApp desconectado para o usuário:', user, 'Razão:', reason);
      delete clients[user];
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
  
  if (!client || !isClientHealthy(client)) {
    return res.json({ ready: false, needsQR: true });
  }
  
  if (client.info) {
    return res.json({ ready: true, needsQR: false, info: client.info });
  }
  
  res.json({ ready: false, needsQR: !!userQRCodes[user] });
});

// NEW: Batch sending endpoint to prevent timeouts
app.post('/api/send-batch', isAuthenticated, upload.fields([ 
  {name: 'numbers', maxCount: 1},
  {name: 'answeredNumbers', maxCount : 1}
]), async (req, res) => {
  const user = req.session.user;
  const sessionId = `${user}-${Date.now()}`;
  
  // Set headers for long-running request
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  const keepAliveCleanup = setupKeepAlive(res);
  
  try {
    const client = clients[user];
    
    if (!client || !isClientHealthy(client)) {
      keepAliveCleanup();
      return res.status(400).json({ error: 'WhatsApp not connected or client unhealthy' });
    }
    
    const { message, batchSize = 10, delayMultiplier = 1 } = req.body;
    const numbersFile = req.files['numbers'][0];
    const answeredFile = req.files['answeredNumbers'] ? req.files['answeredNumbers'][0] : null;
    
    if (!numbersFile || !message) {
      keepAliveCleanup();
      return res.status(400).json({ error: 'Missing message or phone numbers file' });
    }
    
    // File cleanup function
    const cleanupFiles = () => {
      try {
        if (numbersFile && fs.existsSync(numbersFile.path)) {
          fs.unlinkSync(numbersFile.path);
        }
        if (answeredFile && fs.existsSync(answeredFile.path)) {
          fs.unlinkSync(answeredFile.path);
        }
      } catch (error) {
        console.error('Error cleaning up files:', error);
      }
    };
    
    // Read and process files
    const numbersfileContent = fs.readFileSync(numbersFile.path, 'utf-8');
    const phoneNumbers = numbersfileContent
      .split('\n')
      .map(num => num.trim())
      .filter(num => num.length > 0);

    let numbersToSend = phoneNumbers;

    console.log(`[${sessionId}] Original numbers count:`, phoneNumbers.length);

    if (answeredFile) {
      const respondidosContent = fs.readFileSync(answeredFile.path, 'utf-8');
      const respondedNumbers = respondidosContent
        .split('\n')
        .map(num => num.trim())
        .filter(num => num.length > 0)
        .map(num => num.replace(/\D/g, ''));

      console.log(`[${sessionId}] Answered numbers count:`, respondedNumbers.length);

      numbersToSend = phoneNumbers.filter(num => {
        const cleanedNum = num.replace(/\D/g, '');
        return !respondedNumbers.includes(cleanedNum);
      });

      console.log(`[${sessionId}] After filter - Original: ${phoneNumbers.length}, To send: ${numbersToSend.length}`);
    }

    // Initialize session tracking
    activeSessions[sessionId] = {
      user,
      total: numbersToSend.length,
      processed: 0,
      successful: 0,
      failed: 0,
      startTime: Date.now()
    };

    const results = [];
    const actualBatchSize = Math.min(parseInt(batchSize), 15); // Max 15 per batch
    
    // Send initial progress
    res.write(JSON.stringify({
      type: 'progress',
      sessionId,
      total: numbersToSend.length,
      processed: 0,
      successful: 0,
      failed: 0,
      status: 'starting'
    }) + '\n');

    // Process in smaller batches with better error handling
    for (let i = 0; i < numbersToSend.length; i += actualBatchSize) {
      const batch = numbersToSend.slice(i, i + actualBatchSize);
      
      console.log(`[${sessionId}] Processing batch ${Math.floor(i/actualBatchSize) + 1}, size: ${batch.length}`);
      
      const batchResults = await processBatch(client, batch, message, delayMultiplier);
      results.push(...batchResults);
      
      // Update session progress
      const successfulInBatch = batchResults.filter(r => r.status === 'sent').length;
      const failedInBatch = batchResults.filter(r => r.status === 'failed').length;
      
      activeSessions[sessionId].processed += batch.length;
      activeSessions[sessionId].successful += successfulInBatch;
      activeSessions[sessionId].failed += failedInBatch;
      
      // Send progress update
      res.write(JSON.stringify({
        type: 'progress',
        sessionId,
        total: numbersToSend.length,
        processed: activeSessions[sessionId].processed,
        successful: activeSessions[sessionId].successful,
        failed: activeSessions[sessionId].failed,
        currentBatch: batch.length,
        status: 'processing'
      }) + '\n');
      
      // Check client health between batches
      if (!isClientHealthy(client)) {
        throw new Error('WhatsApp client became unhealthy during sending');
      }
      
      // Delay between batches
      if (i + actualBatchSize < numbersToSend.length) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    cleanupFiles();
    delete activeSessions[sessionId];
    
    // Send final result
    res.write(JSON.stringify({
      type: 'complete',
      sessionId,
      success: true,
      results,
      summary: {
        total: numbersToSend.length,
        sent: activeSessions[sessionId]?.successful || 0,
        failed: activeSessions[sessionId]?.failed || 0,
        successRate: ((activeSessions[sessionId]?.successful / numbersToSend.length) * 100).toFixed(2) + '%'
      }
    }) + '\n');
    
    res.end();
    
  } catch (error) {
    console.error(`[${sessionId}] Error in send-batch:`, error);
    keepAliveCleanup();
    cleanupFiles?.();
    delete activeSessions[sessionId];
    
    res.write(JSON.stringify({
      type: 'error',
      sessionId,
      error: 'Failed to process messages',
      details: error.message
    }) + '\n');
    res.end();
  }
});

// Process individual batch
async function processBatch(client, batch, message, delayMultiplier = 1) {
  const batchResults = [];
  
  for (const number of batch) {
    try {
      const formattedNumber = number.replace(/\D/g, '');
      const chatId = formattedNumber.includes('@') 
        ? formattedNumber 
        : `${formattedNumber}@c.us`;
      
      await safeSendMessage(client, chatId, message);
      batchResults.push({ number, status: 'sent' });
      
      // Reduced and configurable delay
      const baseDelay = 8 + getRandomInt(4); // 8-12 seconds base
      const actualDelay = baseDelay * delayMultiplier;
      await new Promise(resolve => setTimeout(resolve, actualDelay * 1000));
      
    } catch (error) {
      console.error(`Error sending to ${number}:`, error.message);
      batchResults.push({ 
        number, 
        status: 'failed', 
        error: error.message
      });
      
      // Shorter delay after failures
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  return batchResults;
}

// Check session progress
app.get('/api/session-progress/:sessionId', isAuthenticated, (req, res) => {
  const sessionId = req.params.sessionId;
  const progress = activeSessions[sessionId];
  
  if (!progress) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json(progress);
});

// Health check endpoint with memory info
app.get('/api/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const memoryMB = {
    rss: Math.round(memoryUsage.rss / 1024 / 1024),
    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
    external: Math.round(memoryUsage.external / 1024 / 1024)
  };
  
  res.json({
    status: 'ok',
    memory: memoryMB,
    uptime: process.uptime(),
    activeSessions: Object.keys(activeSessions).length
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  const user = req.session.user;
  
  // Clean up WhatsApp client on logout
  if (clients[user]) {
    clients[user].destroy().catch(console.error);
    delete clients[user];
  }
  
  delete userQRCodes[user];
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
  console.log('Memory optimization enabled');
});
