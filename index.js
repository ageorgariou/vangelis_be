// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const AWS = require('@aws-sdk/client-s3');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const s3Client = new AWS.S3({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Session storage
const sessions = new Map();

// Helper functions
const updateXLSX = async (userData) => {
    console.log('User Data:', userData);
    const params = {
        Bucket: process.env.S3_BUCKET,
        Key: 'users_vangelis_2.xlsx'
    };

    try {
        const { Body } = await s3Client.send(new GetObjectCommand(params));
        const buffer = await Body.transformToByteArray();
        const workbook = XLSX.read(buffer);
        const ws = workbook.Sheets[workbook.SheetNames[0]];

        // Ensure headers are present
        if (!ws['A1']) {
            console.log('Adding headers');
            XLSX.utils.sheet_add_aoa(ws, [['full_name', 'email', 'phone']], { origin: 'A1' });
        }

        // Log userData to verify structure
        console.log('User Data to be added:', userData);

        // Append new data
        XLSX.utils.sheet_add_json(ws, [userData], { skipHeader: true, origin: -1 });
        const updated = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        console.log('Updated XLSX:', updated);

        await s3Client.send(new PutObjectCommand({
            ...params,
            Body: updated
        }));
    } catch (error) {
        console.error('Error updating XLSX:', error);

        // Create a new workbook if the file doesn't exist
        const newWB = XLSX.utils.book_new();
        const newWS = XLSX.utils.json_to_sheet([userData], { header: ['full_name', 'email', 'phone'] });
        XLSX.utils.book_append_sheet(newWB, newWS, 'Users Vangelis');
        const data = XLSX.write(newWB, { type: 'buffer' });
        console.log('New XLSX:', data);
        await s3Client.send(new PutObjectCommand({
            ...params,
            Body: data
        }));
    }
};

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    const { sessionId, messages } = req.body;
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            info: { fullName: null, email: null, phone: null },
            needsInfo: false
        });
    }

    const session = sessions.get(sessionId);
    const lastMessage = messages[messages.length - 1]?.content || '';

    // Use OpenAI to detect intent and extract information
    try {
        const aiResponse = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: 'Extract intent and user information (full name, email, phone) from the following message and return it as a JSON object:'
            }, {
                role: 'user',
                content: lastMessage
            }],
            temperature: 0.6,
        });

        // Log the response for debugging
        console.log('AI Response:', aiResponse.choices[0].message.content);

        // Attempt to parse the response
        let extractedInfo;
        try {
            extractedInfo = JSON.parse(aiResponse.choices[0].message.content);
            console.log('Extracted Info:', extractedInfo);
        } catch (parseError) {
            console.error('Failed to parse AI response:', parseError);
            return res.status(500).json({ message: 'Σφάλμα κατά την επεξεργασία της απάντησης AI.' });
        }

        Object.keys(extractedInfo).forEach(key => {
            if (extractedInfo[key]) session.info[key] = extractedInfo[key];
        });

        // Check missing fields
        const missing = [];
        console.log('Session Info:', session.info);

        if (session.info.user || session.info.user_information) {
            const user = session.info.user || {};
            const userInformation = session.info.user_information || {};

            if (!user.full_name && !userInformation.full_name) missing.push('ονοματεπώνυμο');
            if (!user.email && !userInformation.email) missing.push('email');
            if (!user.phone && !userInformation.phone) missing.push('τηλέφωνο');
        } else {
            missing.push('Πληροφορίες χρήστη');
        }

        if (missing.length > 0) {
            return res.json({
                message: `Παρακαλώ δώστε ${missing.join(' και ')} σας:`,
                needsInfo: true
            });
        }

        // All info collected
        await updateXLSX(session.info.user_information);
        session.needsInfo = false;

        // Generate AI response
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: `Απάντα στα Ελληνικά. Πληροφορίες χρήστη: ${JSON.stringify(session.info)}`
            }, ...messages],
            temperature: 0.6,
        });
        console.log('AI Response 2:', response.choices[0].message.content);
        res.json({
            message: response.choices[0].message.content,
            needsInfo: false
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Σφάλμα συστήματος. Παρακαλώ δοκιμάστε ξανά.' });
    }
});

// Route to download the XLSX sheet
app.get('/api/download-users', async (req, res) => {
    const params = {
        Bucket: process.env.S3_BUCKET,
        Key: 'users_vangelis_2.xlsx'
    };

    try {
        const { Body } = await s3Client.send(new GetObjectCommand(params));
        const buffer = await Body.transformToByteArray();

        res.setHeader('Content-Disposition', 'attachment; filename=users_vangelis_2.xlsx');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Σφάλμα κατά τη λήψη του αρχείου.' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));