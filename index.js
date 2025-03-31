require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const mammoth = require('mammoth');
const multer = require('multer');

const app = express();
app.use(bodyParser.json());
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allow specific HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'] // Allow specific headers
}));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Enhanced configuration system
let config = {
  systemPrompt: "You are a helpful assistant. Be friendly and keep responses concise.",
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
    fileSize: 10 * 1024 * 1024, // 10MB limit
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
    const file = await openai.files.create({
      file: fileBuffer,
      purpose: "assistants"
    });
    return file.id;
  } catch (error) {
    console.error("Error uploading file to OpenAI:", error);
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
        tools: [{ type: "retrieval" }],
        file_ids: config.knowledgeBase.fileIds
      });
    } else {
      assistant = await openai.beta.assistants.create({
        name: "Vangelis Assistant",
        instructions: config.systemPrompt,
        model: "gpt-4-turbo-preview",
        tools: [{ type: "retrieval" }],
        file_ids: config.knowledgeBase.fileIds
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
      tools: [{ type: "retrieval" }],
      file_ids: config.knowledgeBase.fileIds
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

// Routes
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  // Initialize session
  if (!conversations[sessionId]) {
    conversations[sessionId] = {
      history: [],
      collectedInfo: { name: null, email: null, phone: null },
      currentField: null,
      fieldOrder: ['name', 'email', 'phone'],
      threadId: null
    };
  }

  const session = conversations[sessionId];
  session.history.push({ role: 'user', content: message });

  try {
    if (session.currentField) {
      const value = await extractField(message, session.currentField);
      
      if (value) {
        session.collectedInfo[session.currentField] = value;
        session.history.push({ role: 'assistant', content: `Got your ${session.currentField}!` });
      }

      const nextField = session.fieldOrder.find(f => !session.collectedInfo[f]);
      
      if (nextField) {
        session.currentField = nextField;
        const prompts = {
          name: 'May I have your full name?',
          email: 'What email address should we use?',
          phone: 'Finally, could you share your phone number?'
        };
        return res.json({ response: prompts[nextField] });
      } else {
        await saveToSheet(session);
        session.currentField = null;
        return res.json({ response: 'Thank you! Your information has been saved. How else can I help?' });
      }
    } else {
      // Create or retrieve thread
      if (!session.threadId) {
        const thread = await openai.beta.threads.create();
        session.threadId = thread.id;
      }

      // Add message to thread
      await openai.beta.threads.messages.create(session.threadId, {
        role: "user",
        content: message
      });

      // Run the assistant
      const run = await openai.beta.threads.runs.create(session.threadId, {
        assistant_id: assistant.id
      });

      // Wait for the run to complete
      let runStatus = await openai.beta.threads.runs.retrieve(session.threadId, run.id);
      while (runStatus.status === 'in_progress' || runStatus.status === 'queued') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(session.threadId, run.id);
      }

      if (runStatus.status === 'failed') {
        throw new Error('Assistant run failed');
      }

      // Get the assistant's response
      const messages = await openai.beta.threads.messages.list(session.threadId);
      const lastMessage = messages.data[0];
      const response = lastMessage.content[0].text.value;

      session.history.push({ role: 'assistant', content: response });
      return res.json({ response });
    }
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
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
      mimetype: req.file.mimetype
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
    console.error('Error processing document:', error);
    
    // Send appropriate error response
    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message.includes('Multer error')) {
      return res.status(400).json({ error: error.message });
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));