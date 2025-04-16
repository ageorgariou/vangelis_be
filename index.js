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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allow specific HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'] // Allow specific headers
}));

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

// Conversation state management
const conversations = {};

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

// Assistant management
let assistant = null;

async function uploadFileToOpenAI(fileBuffer, fileName) {
  try {
    console.log('Attempting to upload file to OpenAI:', {
      fileName,
      bufferSize: fileBuffer.length,
      bufferType: typeof fileBuffer,
      isBuffer: Buffer.isBuffer(fileBuffer)
    });

    // Create a new buffer with the correct content type
    const buffer = Buffer.from(fileBuffer);
    
    const file = await openai.files.create({
      file: buffer,
      purpose: "assistants",
      metadata: {
        filename: fileName,
        contentType: 'application/pdf'
      }
    });
    return file.id;
  } catch (error) {
    console.error("Error uploading file to OpenAI:", {
      error: error.message,
      status: error.status,
      type: error.type,
      details: error.error
    });
    throw error;
  }
}

async function initializeAssistant() {
  try {
    // Create or retrieve assistant
    const assistants = await openai.beta.assistants.list();
    const existingAssistant = assistants.data.find(a => a.name === "Vangelis Assistant");
    
    if (existingAssistant) {
      assistant = existingAssistant;
      // Update assistant with current knowledge
      await openai.beta.assistants.update(assistant.id, {
        instructions: config.systemPrompt,
        model: "gpt-4-turbo-preview",
        tools: [{ type: "file_search" }],
        file_id: config.knowledgeBase.fileIds[0]
      });
    } else {
      assistant = await openai.beta.assistants.create({
        name: "Vangelis Assistant",
        instructions: config.systemPrompt,
        model: "gpt-4-turbo-preview",
        tools: [{ type: "file_search" }],
        file_id: config.knowledgeBase.fileIds[0]
      });
    }
  } catch (error) {
    console.error("Error initializing assistant:", error);
    throw error;
  }
}

async function updateAssistantKnowledge() {
  if (!assistant) return;
  
  try {
    await openai.beta.assistants.update(assistant.id, {
      instructions: config.systemPrompt,
      model: "gpt-4-turbo-preview",
      tools: [{ type: "file_search" }],
      file_id: config.knowledgeBase.fileIds[0]
    });
  } catch (error) {
    console.error("Error updating assistant knowledge:", error);
    throw error;
  }
}

// Initialize assistant on startup
initializeAssistant();

// Helper functions
async function detectInterest(conversationHistory) {
  const easinessLevel = config.interestSettings.easiness > 0.8 ? 'high' : 
                       config.interestSettings.easiness > 0.5 ? 'medium' : 'low';
  
  const easinessDescription = {
    high: 'Consider even vague suggestions or potential interest',
    medium: 'Consider both direct statements and strong hints',
    low: 'Only consider clear, direct statements'
  }[easinessLevel];

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{
      role: 'system',
      content: `Analyze conversation history for interest in sharing contact info.
      Criteria: ${config.interestSettings.criteria.join(', ')}
      Sensitivity: ${easinessDescription} (${config.interestSettings.easiness})
      Respond with confidence score (0-100)|yes/no (Example: "75|yes")`
    }, ...conversationHistory]
  });

  const [score, decision] = response.choices[0].message.content.split('|');
  const confidence = parseInt(score) / 100;
  const threshold = 1 - config.interestSettings.easiness;
  
  return confidence >= threshold ? decision.toLowerCase() : 'no';
}

async function extractField(message, field) {
  const examples = {
    name: 'e.g., John Doe, Jane Smith',
    email: 'e.g., user@example.com',
    phone: 'e.g., 123-456-7890, +1 234 567 8900'
  };

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{
      role: 'system',
      content: `Extract ${field} from message. Return ONLY the value or 'null'. ${examples[field]}`
    }, { role: 'user', content: message }]
  });

  return response.choices[0].message.content.trim() === 'null' ? null : response.choices[0].message.content.trim();
}

async function saveToSheet(session) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    resource: { values: [[
      session.collectedInfo.name,
      session.collectedInfo.email,
      session.collectedInfo.phone,
      new Date().toISOString()
    ]]}
  });
}

// Create WebSocket server
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  clientTracking: true,
  perMessageDeflate: true
});

// Add CORS headers for WebSocket connections
wss.on('headers', (headers) => {
  headers.push('Access-Control-Allow-Origin: *');
  headers.push('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
  headers.push('Access-Control-Allow-Headers: Content-Type, Authorization');
});

// Add error handling for WebSocket server
wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

// Constants for configuration
const MAX_HISTORY_LENGTH = 10; // Keep only last 10 messages
const TIMEOUT_MS = 30000; // 30 seconds timeout for API calls
const SESSION_TIMEOUT_MS = 3600000; // 1 hour session timeout
const MAX_CONCURRENT_REQUESTS = 5; // Maximum concurrent requests per session
const RECONNECT_TIMEOUT_MS = 5000; // 5 seconds between reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 3; // Maximum number of reconnection attempts

// Store active connections and their states
const activeConnections = new Map();

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  let isProcessing = false;
  let sessionId = null;
  let reconnectAttempts = 0;

  // Function to handle reconnection
  const handleReconnection = async () => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log(`Max reconnection attempts reached for session ${sessionId}`);
      return;
    }

    reconnectAttempts++;
    console.log(`Attempting reconnection ${reconnectAttempts} for session ${sessionId}`);

    try {
      // Check if session exists
      if (sessionId && conversations[sessionId]) {
        // Send reconnection success message
        ws.send(JSON.stringify({
          type: 'reconnect',
          success: true,
          sessionId: sessionId,
          history: conversations[sessionId].history
        }));
        console.log(`Successfully reconnected session ${sessionId}`);
      } else {
        // Create new session if needed
        sessionId = generateSessionId();
        conversations[sessionId] = {
          history: [
            { role: 'system', content: config.systemPrompt }
          ],
          collectedInfo: { name: null, email: null, phone: null },
          currentField: null,
          fieldOrder: ['name', 'email', 'phone'],
          threadId: null,
          requestCount: 0,
          lastActivity: Date.now()
        };
        ws.send(JSON.stringify({
          type: 'new_session',
          sessionId: sessionId
        }));
      }
    } catch (error) {
      console.error('Reconnection error:', error);
      setTimeout(handleReconnection, RECONNECT_TIMEOUT_MS);
    }
  };

  // Generate unique session ID
  const generateSessionId = () => {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  };

  ws.on('error', (error) => {
    console.error('WebSocket connection error:', error);
    if (sessionId) {
      activeConnections.delete(sessionId);
    }
    ws.close();
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (sessionId) {
      activeConnections.delete(sessionId);
      // Attempt reconnection
      setTimeout(handleReconnection, RECONNECT_TIMEOUT_MS);
    }
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle reconnection request
      if (data.type === 'reconnect' && data.sessionId) {
        sessionId = data.sessionId;
        await handleReconnection();
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
      sessionId = data.sessionId || generateSessionId();
      const content = data.content;
      
      // Store connection
      activeConnections.set(sessionId, ws);
      
      // Initialize session if needed
      if (!conversations[sessionId]) {
        conversations[sessionId] = {
          history: [
            { role: 'system', content: config.systemPrompt }
          ],
          collectedInfo: { name: null, email: null, phone: null },
          currentField: null,
          fieldOrder: ['name', 'email', 'phone'],
          threadId: null,
          requestCount: 0,
          lastActivity: Date.now()
        };

        // Set up session timeout
        setTimeout(() => {
          if (conversations[sessionId]) {
            console.log(`Cleaning up expired session: ${sessionId}`);
            delete conversations[sessionId];
            activeConnections.delete(sessionId);
          }
        }, SESSION_TIMEOUT_MS);
      }

      const session = conversations[sessionId];
      
      // Update last activity
      session.lastActivity = Date.now();
      
      // Check request limit
      if (session.requestCount >= MAX_CONCURRENT_REQUESTS) {
        throw new Error('Too many requests. Please wait before sending more messages.');
      }
      
      session.requestCount++;

      // Limit history length
      session.history.push({ role: 'user', content });
      if (session.history.length > MAX_HISTORY_LENGTH) {
        session.history = [
          session.history[0], // Keep system prompt
          ...session.history.slice(-(MAX_HISTORY_LENGTH - 1))
        ];
      }

      // Set up timeout for the API call
      const timeout = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'error', message: 'Request timed out' }));
        ws.close();
      }, TIMEOUT_MS);

      try {
        // Create streaming response
        const stream = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: session.history,
          stream: true,
          temperature: config.knowledgeBase.temperature,
          max_tokens: config.knowledgeBase.maxTokens
        });

        // Stream the response back to the client
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            ws.send(JSON.stringify({ type: 'chunk', content }));
          }
        }

        // Send completion message
        ws.send(JSON.stringify({ type: 'complete' }));
      } catch (error) {
        console.error('Error in API call:', error);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Error processing your request. Please try again.' 
        }));
      } finally {
        clearTimeout(timeout);
        session.requestCount--;
        isProcessing = false;
      }

    } catch (error) {
      console.error('Error in message handling:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: error.message || 'An error occurred' 
      }));
      isProcessing = false;
    }
  });
});

// Routes
app.post('/chat', (req, res) => {
  res.json({ 
    message: 'Please use WebSocket connection for real-time chat',
    wsUrl: 'wss://vangelis-be-b551180564a5.herokuapp.com'
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

app.post('/update-spreadsheet-id', (req, res) => {
  try {
    const { spreadsheetId } = req.body;
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'Spreadsheet ID is required' });
    }

    process.env.SPREADSHEET_ID = spreadsheetId;
    res.json({ success: true, newSpreadsheetId: process.env.SPREADSHEET_ID });
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
    console.log('File uploaded to OpenAI:', fileId);
    
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));