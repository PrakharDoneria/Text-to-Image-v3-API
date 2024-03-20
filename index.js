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

        const response = await fetch(`http://ip-api.com/json/${ipAddress}`);
        const ipInfo = await response.json();

        if (!ipInfo || ipInfo.proxy || ipInfo.vpn) {
            return res.status(403).json({ error: 'Invalid or VPN IP address.' });
        }

        let user = await User.findOne({ username: androidId });
        const now = Date.now();

        if (!user || (user.lastRequestTimestamp && (now - user.lastRequestTimestamp) >= 24 * 60 * 60 * 1000)) {
            user = await User.findOneAndUpdate(
                { username: androidId },
                { lastRequestTimestamp: now, requestsMade: 0, userType: 'free', premiumExpiration: null },
                { upsert: true, new: true }
            );
        }

        if (user.userType === 'free' && user.requestsMade >= 3) {
            return res.status(403).json({ error: 'Daily limit exceeded for free users. Upgrade to pro for unlimited access.' });
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
    } catch (error) {
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
/*
async function sendDeployHookRequest() {
    try {
        const deployKey = process.env.DEPLOY_KEY;
        const response = await fetch(`https://api.render.com/deploy/srv-cnjggcuct0pc73cb0atg?key=${deployKey}`, { method: 'POST' });
        if (!response.ok) {
            console.error('Failed to send deploy hook request');
        } else {
            console.log('Deploy hook request sent successfully');
        }
    } catch (error) {
        console.error('Error sending deploy hook request:', error);
    }
}

function scheduleTasks() {
    sendDeployHookRequest();

    setTimeout(scheduleTasks, 5 * 60 * 1000);
}

scheduleTasks();
*/


const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});