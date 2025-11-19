require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const mammoth = require('mammoth');
const multer = require('multer');
const WebSocket = require('ws');

const app = express();

// Add request logging middleware FIRST to see all incoming requests
app.use((req, res, next) => {
  console.log(`\n📥 Incoming ${req.method} request:`, req.url);
  console.log('  Origin:', req.headers.origin || 'none');
  console.log('  User-Agent:', req.headers['user-agent']?.substring(0, 50) || 'none');
  next();
});

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Enhanced CORS configuration
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handle preflight requests explicitly
app.options('*', cors());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Enhanced configuration system
let config = {
  systemPrompt: `PROMPT FOR AI CHATBOT: "LUCCA" – GRUPPO CUCINE
You are Lucca, the official AI sales agent of Gruppo Cucine, Greece's top brand for high-end kitchen furniture.
Your role is to chat with customers in perfect, natural Greek using short, human-like messages to:
* Start a natural conversation
* Understand what the customer is looking for
* Provide accurate, helpful info (from the FAQ)

SPEAKING STYLE
* Greek ONLY (native level)- ALWAYS SPEAK IN GREEK!!
* Short, simple sentences (2 lines max)
* Friendly, calm, confident
* Natural like a showroom rep from Athens
* No emojis, no robotic phrasing
* Always end with a question that keeps the convo going till you see that the user has no more questions so you're still there if you need to seem helpfull
* Ensure all responses are written in grammatically correct, fluent Greek. Use native sentence structure, proper verb conjugations, and correct spelling. Do not translate directly from English. Your Greek must sound natural, local, and professional — exactly like a native Greek speaker would write or speak. Never use unnatural expressions or awkward phrasing.

OPENING LINE
Γεια σου! Είμαι ο Lucca, ο ψηφιακός βοηθός της Gruppo Cucine. Πώς μπορώ να σε βοηθήσω;

KNOWLEDGE BASE (MUST BE USED NATURALLY IN RESPONSES)
ΕΤΑΙΡΕΙΑ
* Η Gruppo Cucine λειτουργεί στην Ελλάδα από το 2003 (52 χρόνια εμπειρία).
* Συνεργάτες με 9 Ιταλικούς οίκους (π.χ. Val Cucine, Snaidero, Evo Cucine).
* Ολα τα έπιπλα και πάγκοι είναι Made in Italy.

ΚΑΤΑΣΤΗΜΑΤΑ
* Χαλάνδρι, Γλυφάδα, Βούλα, Νέα Σμύρνη, Άγια Παρασκευή, Χαϊδάρι.
* Ώρες: 9:00-21:00 καθημερινές, Σάββατο 9:00-15:00.

ΠΡΟΪΟΝΤΑ
* Κάθε υλικά: βακελίτη, ξύλο, θερμοπρεσαριστές, κεραμικές πόρτες.
* Εγγύηση έως 10 χρόνια ανά λογή της μάρκας.
* Οι μηχανισμοί δεν μπορούν να τοποθετηθούν χωρίς του budget.

ΥΠΗΡΕΣΙΕΣ
* Γίνεται επιμέτρηση χώρου, εκθέσεις και after-sales service.
* Παρέχουμε και αποξήλωση παλιάς κουζίνας.
* Χρόνος παράδοσης: 8–12 εβδομάδες.
* Γίνεται αποθήκευση της κουζίνας εάν ο χώρος σας δεν είναι έτοιμος.

ΟΙΚΟΝΟΜΙΚΑ
* Δεν υπάρχει συγκεκριμένη τιμή.
* Δεν κανονίζουμε τιμές ανά μέτρο.
* Πληρωμές: μετρητά, κάρτα, τράπεζα, δόση ή Eurobank.

SALES BEHAVIOR
* End messages like:
* "Να σας καλέσει ένας σύμβουλος να σας εξηγήσει;"
* "Θέλετε να το δούμε από κοντά μαζί;"
* "Να κλείσουμε ένα ραντεβού στο showroom;"

Please keep the answers super short and concise, 2 sentences max`,
  interestSettings: {
    easiness: 1,
    criteria: [
      "Mentioning contact information",
      "Asking about updates or notifications",
      "Expressing interest in products/services"
    ]
  },
  knowledgeBase: {
    fileIds: [],
    urls: [],
    maxTokens: 4000,
    temperature: 0.7
  }
};

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Configure multer with better error handling
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only specific file types
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and DOCX files are allowed.'));
    }
  }
}).single('document');

// Wrap multer in a promise for better error handling
const uploadMiddleware = (req, res) => {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        reject(new Error(`Multer error: ${err.message}`));
      } else if (err) {
        reject(new Error(err.message));
      } else {
        resolve();
      }
    });
  });
};

// Constants for configuration
const TIMEOUT_MS = 30000; // 30 seconds timeout for API calls

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server
let wss;
try {
  wss = new WebSocket.Server({ 
    server,
    path: '/ws'
  });
  console.log('✅ WebSocket server created successfully');
} catch (wsError) {
  console.error('❌ Failed to create WebSocket server:', wsError);
  console.error('Error stack:', wsError?.stack);
  throw wsError;
}

// Session management
const sessions = new Map(); // Store sessions by connection ID
let connectionIdCounter = 0;

// WebSocket server error handling
wss.on('error', (error) => {
  console.error('\n❌ WebSocket server error:');
  console.error('  Error:', error);
  console.error('  Stack:', error?.stack);
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Unhandled Rejection:');
  console.error('  Reason:', reason);
  console.error('  Promise:', promise);
  if (reason instanceof Error) {
    console.error('  Stack:', reason.stack);
  }
});

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('\n❌ Uncaught Exception:');
  console.error('  Error:', error);
  console.error('  Stack:', error?.stack);
});

// WebSocket connection handling
console.log('📡 Registering WebSocket connection handler...');
wss.on('connection', (ws, req) => {
  try {
    const connectionId = `ws_${++connectionIdCounter}_${Date.now()}`;
    console.log('\n=== NEW WEBSOCKET CONNECTION ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Connection ID:', connectionId);
    console.log('Remote address:', req.socket.remoteAddress);
    console.log('Request headers:', JSON.stringify(req.headers || {}));
    
    let isProcessing = false;
    let chatHistory = [];
    let heartbeatInterval = null;

    // Initialize session
    try {
      sessions.set(connectionId, { 
        chatHistory: [], 
        lastActive: Date.now(),
        ws: ws
      });
      console.log('Created new session:', connectionId);
    } catch (sessionError) {
      console.error('Error initializing session:', sessionError);
      console.error('Session error stack:', sessionError?.stack);
      sessions.set(connectionId, { chatHistory: [], lastActive: Date.now(), ws: ws });
      chatHistory = [];
    }

    console.log('Session initialized successfully');

    // Start heartbeat/ping interval
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (err) {
          console.error('Error sending ping:', err);
        }
      }
    }, 30000); // Send ping every 30 seconds

    // Handle incoming messages
    ws.on('message', async (message) => {
      let timeout = null;
      try {
        const data = JSON.parse(message);
        console.log('Received message:', JSON.stringify(data).substring(0, 100));
        
        // Handle pong responses
        if (data.type === 'pong') {
          sessions.get(connectionId).lastActive = Date.now();
          return;
        }
        
        // Prevent concurrent processing
        if (isProcessing) {
          ws.send(JSON.stringify({ 
            type: 'error',
            message: 'Please wait for the previous message to complete' 
          }));
          return;
        }

        isProcessing = true;
        
        // Extract message content
        const content = data.content;
        if (!content || content.trim() === '') {
          console.error('Empty message content');
          throw new Error('Message content cannot be empty');
        }

        console.log('Processing message:', content.substring(0, 50));

        // Add user message to chat history
        chatHistory.push({ role: 'user', content });
        sessions.get(connectionId).chatHistory = chatHistory;
        sessions.get(connectionId).lastActive = Date.now();

        // Set up timeout for the API call
        timeout = setTimeout(() => {
          console.error('Request timeout for session:', connectionId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'error',
              message: 'Request timed out' 
            }));
          }
          isProcessing = false;
        }, TIMEOUT_MS);

        // Check if OpenAI API key is configured
        if (!process.env.OPENAI_API_KEY) {
          throw new Error('OpenAI API key is not configured');
        }

        // Validate OpenAI client
        if (!openai) {
          throw new Error('OpenAI client is not initialized');
        }

        try {
          console.log('Calling OpenAI API with', chatHistory.length, 'messages');
          console.log('System prompt length:', config.systemPrompt?.length || 0);
          
          // Create streaming response with full chat history
          const stream = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: [
              { role: 'system', content: config.systemPrompt },
              ...chatHistory
            ],
            stream: true,
            temperature: config.knowledgeBase.temperature || 0.7
          }).catch(err => {
            console.error('OpenAI API call failed:', err);
            console.error('Error details:', err.message, err.status, err.response?.data);
            throw err;
          });

          let fullResponse = '';
          // Stream the response back to the client as chunks
          for await (const chunk of stream) {
            const chunkContent = chunk.choices[0]?.delta?.content || '';
            if (chunkContent) {
              fullResponse += chunkContent;
              // Send chunk to client
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'chunk',
                  content: fullResponse
                }));
              }
            }
          }

          console.log('OpenAI response received, length:', fullResponse.length);

          // Add assistant response to chat history
          chatHistory.push({ role: 'assistant', content: fullResponse });
          sessions.get(connectionId).chatHistory = chatHistory;
          sessions.get(connectionId).lastActive = Date.now();

          // Send completion message
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'complete',
              content: fullResponse 
            }));
          }
          console.log('Response sent to client');
        } catch (error) {
          console.error('Error processing message with OpenAI:', error);
          console.error('Error details:', error.message, error.stack);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'error',
              message: error.message || 'An error occurred while processing your message' 
            }));
          }
        } finally {
          if (timeout) clearTimeout(timeout);
          isProcessing = false;
        }
      } catch (error) {
        console.error('Error handling message:', error);
        console.error('Error stack:', error.stack);
        if (timeout) clearTimeout(timeout);
        isProcessing = false;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'error',
              message: error.message || 'Invalid message format' 
            }));
          }
        } catch (sendError) {
          console.error('Error sending error message:', sendError);
        }
      }
    });

    // Handle connection close
    ws.on('close', () => {
      try {
        console.log('Client disconnected:', connectionId);
        
        // Clear heartbeat interval
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        
        // Keep session for 1 hour after last activity
        setTimeout(() => {
          if (sessions.has(connectionId) && 
              Date.now() - sessions.get(connectionId).lastActive > 3600000) {
            sessions.delete(connectionId);
            console.log('Session expired and removed:', connectionId);
          }
        }, 3600000);
      } catch (error) {
        console.error('Error in close handler:', error);
      }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error('WebSocket error for session', connectionId, ':', error);
      console.error('Error stack:', error?.stack);
    });
    
    console.log('All event handlers registered successfully');
  } catch (connectionError) {
    console.error('=== CRITICAL ERROR IN CONNECTION HANDLER ===');
    console.error('Error:', connectionError);
    console.error('Error message:', connectionError?.message);
    console.error('Error stack:', connectionError?.stack);
    
    // Try to close gracefully
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch (closeError) {
      console.error('Error closing websocket:', closeError);
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    websocket: 'enabled',
    timestamp: new Date().toISOString(),
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    activeConnections: sessions.size
  });
});

// Test WebSocket endpoint
app.get('/test-ws', (req, res) => {
  res.json({ 
    message: 'WebSocket server is running',
    websocketEnabled: true,
    path: '/ws',
    activeConnections: sessions.size
  });
});

// Routes
app.post('/chat', (req, res) => {
  res.json({ 
    message: 'Please use WebSocket connection for real-time chat',
    wsUrl: 'wss://gruppocb-f23c19cea41a.herokuapp.com/ws'
  });
});

app.post('/update-config', (req, res) => {
  try {
    if (req.body.easiness !== undefined) {
      config.interestSettings.easiness = Math.min(1, Math.max(0, parseFloat(req.body.easiness)));
    }
    
    if (req.body.criteria) {
      config.interestSettings.criteria = Array.isArray(req.body.criteria) ? 
        req.body.criteria : 
        [req.body.criteria];
    }

    res.json({ 
      success: true,
      config: config.interestSettings
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

app.post('/update-prompt', (req, res) => {
  try {
    if (!req.body.prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    config.systemPrompt = req.body.prompt;
    res.json({ success: true, newPrompt: config.systemPrompt });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

app.post('/add-urls', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'An array of URLs is required' });
    }

    // Add URLs to knowledge base
    config.knowledgeBase.urls.push(...urls);

    // Update system prompt with URLs
    urls.forEach(url => {
      config.systemPrompt += ` Go through this URL for reference and knowledge base: ${url}`;
    });

    // Update assistant knowledge
    await updateAssistantKnowledge();

    res.json({ success: true, newPrompt: config.systemPrompt });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add URLs to prompt' });
  }
});

// Add function to read from Google Sheets
async function readFromGoogleSheets(spreadsheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'A:Z', // Read all columns
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('No data found in spreadsheet');
      return '';
    }

    // Convert spreadsheet data to a formatted string
    let spreadsheetContent = '\nKNOWLEDGE FROM SPREADSHEET:\n';
    rows.forEach((row, index) => {
      if (index === 0) {
        // Add headers
        spreadsheetContent += 'HEADERS: ' + row.join(' | ') + '\n';
      } else {
        // Add data rows
        spreadsheetContent += row.join(' | ') + '\n';
      }
    });

    return spreadsheetContent;
  } catch (error) {
    console.error('Error reading from Google Sheets:', error);
    return '';
  }
}

// Update the updateAssistantKnowledge function
async function updateAssistantKnowledge(spreadsheetId) {
  try {
    // Read from Google Sheets
    const spreadsheetContent = await readFromGoogleSheets(spreadsheetId);
    
    // Update system prompt with spreadsheet content
    if (spreadsheetContent) {
      config.systemPrompt += spreadsheetContent;
    }
    
    console.log('Updated system prompt:', config.systemPrompt);
    // Update with other knowledge sources (URLs and files)
    if (config.knowledgeBase.urls.length > 0) {
      config.systemPrompt += '\nKNOWLEDGE FROM URLs:\n';
      config.knowledgeBase.urls.forEach(url => {
        config.systemPrompt += `- ${url}\n`;
      });
    }
    
    if (config.knowledgeBase.fileIds.length > 0) {
      config.systemPrompt += '\nKNOWLEDGE FROM UPLOADED FILES:\n';
      config.knowledgeBase.fileIds.forEach(fileId => {
        config.systemPrompt += `- File ID: ${fileId}\n`;
      });
    }
  } catch (error) {
    console.error('Error updating assistant knowledge:', error);
  }
}

// Update the update-spreadsheet-id endpoint to also update knowledge
app.post('/update-spreadsheet-id', async (req, res) => {
  try {
    const { spreadsheetId } = req.body;
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'Spreadsheet ID is required' });
    }


    // Update assistant knowledge with new spreadsheet data
    await updateAssistantKnowledge(spreadsheetId);
    
    res.json({ 
      success: true, 
      newSpreadsheetId: spreadsheetId,
      message: 'Spreadsheet ID updated and knowledge base refreshed'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update spreadsheet ID' });
  }
});

app.post('/add-docx', async (req, res) => {
  try {
    // Handle file upload with proper error handling
    await uploadMiddleware(req, res);

    if (!req.file) {
      return res.status(400).json({ error: 'No document provided' });
    }

    console.log('File received:', {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      bufferSize: req.file.buffer.length,
      isBuffer: Buffer.isBuffer(req.file.buffer)
    });

    // Upload file to OpenAI
    const fileId = await uploadFileToOpenAI(req.file.buffer, req.file.originalname);
    console.log('File uploaded to OpenAI: ', fileId);
    
    // Add file ID to knowledge base
    config.knowledgeBase.fileIds.push(fileId);

    // Update assistant knowledge
    await updateAssistantKnowledge();

    res.json({ 
      success: true, 
      message: 'Document added to knowledge base',
      fileId: fileId
    });
  } catch (error) {
    console.error('Error processing document:', {
      error: error.message,
      status: error.status,
      type: error.type,
      details: error.error
    });
    
    // Send appropriate error response
    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message.includes('Multer error')) {
      if (error.message.includes('File too large')) {
        return res.status(413).json({ 
          error: 'File size exceeds the limit. Maximum file size is 50MB.',
          details: error.message
        });
      }
      return res.status(400).json({ error: error.message });
    }
    if (error.status === 413) {
      return res.status(413).json({ 
        error: 'File size exceeds the limit. Maximum file size is 50MB.',
        details: error.message
      });
    }
    return res.status(500).json({ 
      error: 'Failed to process document',
      details: error.message
    });
  }
});

app.post('/remove-knowledge', async (req, res) => {
  try {
    // Reset the system prompt and knowledge base
    config.systemPrompt = "You are a helpful assistant. Be friendly and keep responses concise.";
    config.knowledgeBase.fileIds = [];
    config.knowledgeBase.urls = [];
    
    // Update assistant knowledge
    await updateAssistantKnowledge();
    
    res.json({ 
      success: true, 
      message: 'Knowledge base has been reset'
    });
  } catch (error) {
    console.error('Error resetting knowledge base:', error);
    res.status(500).json({ error: 'Failed to reset knowledge base' });
  }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n✅ ============================================`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ WebSocket server initialized`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`✅ WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`✅ ============================================\n`);
});