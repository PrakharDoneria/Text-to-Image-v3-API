import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import admin from 'firebase-admin';
import { randomBytes } from 'crypto';

const app = express();

dotenv.config();

const firebaseConfig = {
    credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_KEY)),
    storageBucket: "codepulse-india.appspot.com"
};

const storage = admin.initializeApp(firebaseConfig).storage();

const dbURI = process.env.MONGODB_URI;
mongoose.connect(dbURI);

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
    console.log("Connected to MongoDB");
});

const userSchema = new mongoose.Schema({
    username: String,
    lastRequestTimestamp: Date,
    requestsMade: Number,
    userType: String,
    premiumExpiration: Date
});

const User = mongoose.model('User', userSchema);

app.get('/', (req, res) => {
    res.send('Server is running');
});

async function isValidAndroidId(androidId) {
    if (typeof androidId !== 'string') {
        return false;
    }

    if (androidId.length !== 16) {
        return false;
    }

    for (let i = 0; i < androidId.length; i++) {
        const charCode = androidId.charCodeAt(i);
        if (!((charCode >= 48 && charCode <= 57) ||
              (charCode >= 65 && charCode <= 70) ||
              (charCode >= 97 && charCode <= 102))) {
            return false;
        }
    }

    return true;
}

app.get('/add', async (req, res) => {
    const androidId = req.query.id;

    if (!androidId) {
        return res.status(400).json({ error: 'Android ID is required.' });
    }

    try {
        const isValidId = isValidAndroidId(androidId);
        if (!isValidId) {
            return res.status(403).json({ error: 'Invalid Android ID.' });
        }

        let user = await User.findOne({ username: androidId });

        const expirationDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        if (!user) {
            user = await User.create({ username: androidId, lastRequestTimestamp: Date.now(), requestsMade: 0, userType: 'PAID', premiumExpiration: expirationDate });
        } else {
            user.userType = 'PAID';
            user.premiumExpiration = expirationDate;
            await user.save();
        }

        res.json({ code: 200, message: 'Account upgraded to premium successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

app.get('/check/:androidId', async (req, res) => {
    try {
        const androidId = req.params.androidId;

        const isValidId = isValidAndroidId(androidId);
        if (!isValidId) {
            return res.status(400).json({ error: 'Invalid Android ID.' });
        }

        const user = await User.findOne({ username: androidId });

        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const userType = user.userType === 'PAID' ? 'PAID' : 'FREE';
        res.json({ msg: userType });
    } catch (error) {
        console.error("Error retrieving user data:", error);
        res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

app.get('/info/:androidId', async (req, res) => {
    try {
        const androidId = req.params.androidId;

        // Validate Android ID format
        if (!isValidAndroidId(androidId)) {
            return res.status(400).json({ error: 'Invalid Android ID format.' });
        }

        // Find the user in the database
        const user = await User.findOne({ username: androidId });

        // If user not found, return error
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Return user details
        res.json({
            username: user.username,
            lastRequestTimestamp: user.lastRequestTimestamp,
            requestsMade: user.requestsMade,
            userType: user.userType,
            premiumExpiration: user.premiumExpiration
        });
    } catch (error) {
        console.error("Error retrieving user data:", error);
        res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

app.get('/ban/:androidId', async (req, res) => {
    try {
        const androidId = req.params.androidId;

        const isValidId = isValidAndroidId(androidId);
        if (!isValidId) {
            return res.status(400).json({ error: 'Invalid Android ID.' });
        }

        let user = await User.findOne({ username: androidId });

        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        user.userType = 'BANNED';
        await user.save();

        res.json({ message: 'User banned successfully.' });
    } catch (error) {
        console.error("Error banning user:", error);
        res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

app.get('/prompt', async (req, res) => {
    const prompt = req.query.prompt;
    const ipAddress = req.query.ip;
    const androidId = req.query.id;

    if (!prompt || !ipAddress || !androidId) {
        return res.status(400).json({ error: 'Prompt, IP address, and Android ID are required.' });
    }

    try {
        const isValidId = isValidAndroidId(androidId);
        if (!isValidId) {
            return res.status(403).json({ error: 'Invalid Android ID.' });
        }

        const user = await User.findOne({ username: androidId });

        if (!user || user.userType === 'BANNED') {
            return res.status(403).json({ error: 'User is banned. Upgrade to pro to access the service.' });
        }

        if (user.userType === 'FREE' && user.requestsMade >= 3) {
            return res.status(403).json({ error: 'Daily limit exceeded for free users. Upgrade to pro for unlimited access.' });
        }

        const now = Date.now();

        // Reset requests made if it's a new day
        if (user.lastRequestTimestamp && !isSameDay(now, user.lastRequestTimestamp)) {
            user.requestsMade = 0;
        }

        user.requestsMade++;
        user.lastRequestTimestamp = now;
        await user.save();

        const imageUrl = await getProLLMResponse(prompt);
        if (imageUrl.error) {
            console.error("Error generating LLM response:", imageUrl.error);
            return res.status(500).json({ error: imageUrl.error });
        }

        res.json({ code: 200, url: imageUrl });
    } catch (error)
      {
        console.error("Internal server error:", error);
        res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

async function getProLLMResponse(prompt) {
    try {
        const seedBytes = randomBytes(4);
        const seed = seedBytes.readUInt32BE();

        const data = {
            width: 1024,
            height: 1024,
            seed: seed,
            num_images: 1,
            modelType: process.env.MODEL_TYPE,
            sampler: 9,
            cfg_scale: 3,
            guidance_scale: 3,
            strength: 1.7,
            steps: 30,
            high_noise_frac: 1,
            negativePrompt: 'ugly, deformed, noisy, blurry, distorted, out of focus, bad anatomy, extra limbs, poorly drawn face, poorly drawn hands, missing fingers',
            prompt: prompt,
            hide: false,
            isPrivate: false,
            batchId: '0yU1CQbVkr',
            generateVariants: false,
            initImageFromPlayground: false,
            statusUUID: process.env.STATUS_UUID
        };

        const response = await fetch(process.env.BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': process.env.COOKIES
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            console.error("Failed to generate LLM response. HTTP status:", response.status);
            return { error: 'Failed to generate LLM response. Please try again later.' };
        }

        const json = await response.json();

        if (!json.images || !json.images[0] || !json.images[0].imageKey) {
            console.error("Failed to parse LLM response:", json);
            return { error: 'Failed to parse LLM response. Please try again later.' };
        }

        const imageUrl = `https://images.playground.com/${json.images[0].imageKey}.jpeg`;

        return imageUrl;
    } catch (error) {
        console.error("Error generating LLM response:", error);
        return { error: 'Internal server error. Please try again later.' };
    }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

function isSameDay(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
}
