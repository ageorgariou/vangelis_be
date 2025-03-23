require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { OpenAI } = require('openai');
const { google } = require('googleapis');


const app = express();
app.use(bodyParser.json());
app.use(cors());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Configuration system
let config = {
  systemPrompt: "You are a helpful assistant. Be friendly and keep responses concise.",
  interestSettings: {
    easiness: 1, // Range: 0-1 (higher = easier to trigger interest)
    criteria: [
      "Mentioning contact information",
      "Asking about updates or notifications",
      "Expressing interest in products/services"
    ]
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
      fieldOrder: ['name', 'email', 'phone']
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
      // Analyze last 3 exchanges (6 messages)
      const historyForAnalysis = session.history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6);

      const isInterested = await detectInterest(historyForAnalysis);
      
      if (isInterested === 'yes') {
        session.currentField = session.fieldOrder.find(f => !session.collectedInfo[f]);
        const response = session.currentField ? 
          `Great! Let's get your contact info. ${session.currentField === 'name' ? 
            'May I have your full name?' : 
            'What email address should we use?'}` :
          'We already have your info. How can I help?';
        
        session.history.push({ role: 'assistant', content: response });
        return res.json({ response });
      }

      // Generate normal response
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{
          role: 'system',
          content: config.systemPrompt
        }, ...session.history]
      });

      const response = completion.choices[0].message.content;
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

app.post('/add-urls', (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'An array of URLs is required' });
    }

    // Append each URL to the system prompt
    urls.forEach(url => {
      config.systemPrompt += ` Go through this URL for reference and knowledge base: ${url}`;
    });

    res.json({ success: true, newPrompt: config.systemPrompt });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add URLs to prompt' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));