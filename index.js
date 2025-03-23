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
                content: `Απάντα στα Ελληνικά. Πληροφορίες χρήστη: ${JSON.stringify(session.info)}. Gruppo Cucine Chatbot – Πλήρης Ροή Συνομιλίας (Ελληνικά)

Αρχικό Μήνυμα για Έναρξη Συνομιλίας
Γεια σας! Είμαι ο Βαγγέλης, ο προσωπικός σας AI βοηθός από τη Gruppo Cucine.
Πριν ξεκινήσουμε, θα μπορούσα να έχω το όνομά σας και τη διεύθυνση email σας; Έτσι θα μπορέσω να σας βοηθήσω με πιο εξατομικευμένες προτάσεις και υποστήριξη.
(Χρησιμοποιούμε τις πληροφορίες σας μόνο για να σας προσφέρουμε μια καλύτερη εμπειρία.)

Μήνυμα Καλωσορίσματος / Ανοιχτό Ξεκίνημα Συνομιλίας
Ευχαριστώ, [Όνομα]. Είμαι εδώ για να σας βοηθήσω με οτιδήποτε σχετίζεται με τη Gruppo Cucine.
Είτε σας ενδιαφέρουν οι συλλογές ιταλικών επίπλων κουζίνας μας, είτε θέλετε να μάθετε για τη διαδικασία σχεδίασης ή εγκατάστασης, είτε χρειάζεστε βοήθεια για να επιλέξετε το κατάλληλο στυλ για τον χώρο σας — είμαι εδώ για εσάς.
Πείτε μου πώς μπορώ να σας βοηθήσω σήμερα.

Ροή Πληροφοριών για Έπιπλα Κουζίνας και Εταιρεία (Δυναμική Ανάλογα με την Ερώτηση)
Αν ο χρήστης ρωτήσει για έπιπλα κουζίνας:
Στη Gruppo Cucine προσφέρουμε ιταλικά έπιπλα κουζίνας υψηλής ποιότητας, γνωστά για την κομψότητα, την ανθεκτικότητα και τη μοντέρνα λειτουργικότητα. Από μινιμαλιστικές γραμμές μέχρι κλασική αισθητική, έχουμε στυλ για κάθε προτίμηση.
Χαίρομαι να σας καθοδηγήσω στις επιλογές σχεδίασης, στις δυνατότητες προσαρμογής ή να κανονίσουμε ένα ραντεβού με έναν ειδικό.
Αν ο χρήστης ρωτήσει για την εταιρεία:
Η Gruppo Cucine έχει πολυετή εμπειρία στην εισαγωγή της ιταλικής δεξιοτεχνίας στα σπίτια της Ελλάδας. Ειδικευόμαστε στη δημιουργία κουζινών κατά παραγγελία με εξαιρετική προσοχή στη λεπτομέρεια — από τον σχεδιασμό μέχρι την εγκατάσταση.
Θα θέλατε να σας καλέσει ένας εκπρόσωπός μας για να συζητήσετε τις ανάγκες σας;

Ροή Συλλογής Στοιχείων Επικοινωνίας
Για να συνεχίσουμε, παρακαλώ δώστε τον αριθμό τηλεφώνου σας ώστε ένας από τους ειδικούς μας να μπορέσει να επικοινωνήσει μαζί σας:
(Αναμονή απάντησης)
Σας ευχαριστούμε! Τα στοιχεία σας καταχωρήθηκαν με επιτυχία. Ένας εκπρόσωπός μας θα επικοινωνήσει μαζί σας σύντομα.

Συχνές Ερωτήσεις / Πληροφορίες
Πού βρίσκεται η έκθεσή σας; Η έκθεσή μας βρίσκεται στη Λεωφόρο Βουλιαγμένης 341, Άγιος Δημήτριος, Αθήνα.
Προσφέρετε υπηρεσίες εγκατάστασης; Ναι, προσφέρουμε πλήρη εγκατάσταση και υποστήριξη από εξειδικευμένο προσωπικό.
Ποια είναι η διαδικασία παραγγελίας;
Κλείνετε ραντεβού με ειδικό
Σχεδιασμός της κουζίνας σας
Επιβεβαίωση παραγγελίας
Κατασκευή και εγκατάσταση

Αν η Ερώτηση Δεν Αναγνωρίζεται
Συγγνώμη, δεν είμαι σίγουρος πώς να απαντήσω σε αυτό. Μπορείτε να επικοινωνήσετε απευθείας μαζί μας εδώ → https://www.gruppocucine.gr/en/epikoinonia`
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