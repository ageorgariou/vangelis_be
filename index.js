// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
// const { google } = require('googleapis');
const cors = require('cors');
const xlsx = require('xlsx');
const path = require('path');
const AWS = require('aws-sdk');
const { S3 } = require('aws-sdk');


const app = express();
app.use(express.json());
app.use(cors({
  origin: '*', // Allow all origins or specify like 'https://your-ngrok-url.ngrok.io'
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const port = process.env.PORT || 3000;

// Configure AWS SDK
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const s3 = new S3();

// Endpoint to make a web call
app.post('/create-web-call', async (req, res) => {
    const agent_id = process.env.AGENT_ID; // Get agent_id from environment variables

    try {
        const response = await axios.post(
            'https://api.retellai.com/v2/create-web-call',
            { agent_id },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.BEARER_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        res.status(201).json(response.data);
    } catch (error) {
        console.error('Error creating web call:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create web call' });
    }
});

// Function to update a local Excel spreadsheet
async function updateLocalSpreadsheet(data) {
    const filePath = path.join(__dirname, 'local_spreadsheet.xlsx'); // Path to your local Excel file

    // Read the existing workbook
    let workbook;
    try {
        workbook = xlsx.readFile(filePath);
    } catch (error) {
        // If the file doesn't exist, create a new workbook
        workbook = xlsx.utils.book_new();
    }

    // Get the first sheet or create a new one
    const sheetName = 'Sheet1';
    let worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
        worksheet = xlsx.utils.aoa_to_sheet([]);
        xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
    }

    // Convert the data to a row format
    const newRow = [data.date, data.fullname, data.interest, data.phone, data.email];

    // Append the new row to the worksheet
    const sheetData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    sheetData.push(newRow);
    const newWorksheet = xlsx.utils.aoa_to_sheet(sheetData);

    // Replace the old sheet with the new one
    workbook.Sheets[sheetName] = newWorksheet;

    // Write the updated workbook to a buffer
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Upload the buffer to S3
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: 'local_spreadsheet.xlsx',
        Body: buffer,
        ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };

    try {
        await s3.upload(params).promise();
        console.log('File uploaded successfully to S3');
    } catch (error) {
        console.error('Error uploading file to S3:', error.message);
        throw new Error('Failed to upload file to S3');
    }
}

// Webhook endpoint to receive post-analysis data
app.post('/webhook', async (req, res) => {
    const postAnalysisData = req.body;

    if (postAnalysisData.event === 'call_analyzed') {
        let analysis;
        try {
            const response = await axios.get(`https://api.retellai.com/v2/get-call/${postAnalysisData.call.call_id}`, {
                headers: {
                    'Authorization': `Bearer ${process.env.BEARER_TOKEN}`
                }
            });
            const callData = response.data;
            analysis = callData.call_analysis;

            console.log(analysis);

            // Update local spreadsheet with custom_analysis_data
            try {
                await updateLocalSpreadsheet(analysis.custom_analysis_data);
                res.status(200).json({ message: 'Webhook processed and data added to local spreadsheet successfully' });
            } catch (error) {
                console.error('Error updating local spreadsheet:', error.message);
                res.status(500).json({ error: 'Failed to update local spreadsheet' });
            }

        } catch (err) {
            console.error("Error fetching or saving call analysis for call ID", postAnalysisData.call.call_id, err.response?.data || err.message);
            res.status(500).json({ error: 'Failed to process webhook' });
        }
    } else {
        res.status(400).json({ error: 'Invalid event type' });
    }
});

app.get('/generate-presigned-url', async (req, res) => {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: 'local_spreadsheet.xlsx',
        Expires: 60 // URL expires in 60 seconds
    };

    try {
        const url = await s3.getSignedUrlPromise('getObject', params);
        res.status(200).json({ url });
    } catch (error) {
        console.error('Error generating pre-signed URL:', error.message);
        res.status(500).json({ error: 'Failed to generate pre-signed URL' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});