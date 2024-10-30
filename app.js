// server.js (Express.js backend)
const express = require("express");
const admin = require("firebase-admin");
const mongoose = require("mongoose");

// Initialize Firebase Admin
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), // Convert \n string to actual newlines
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB User Schema
const userTokenSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  fcmTokens: [
    {
      token: { type: String, required: true },
      device: { type: String },
      lastUsed: { type: Date, default: Date.now },
    },
  ],
});

const UserToken = mongoose.model("UserToken", userTokenSchema);

const app = express();
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_CONN_STRING, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Register/Update FCM token for a user
app.post("/register-token", async (req, res) => {
  try {
    const { userId, fcmToken, deviceInfo } = req.body;

    // Update or create user token document
    const result = await UserToken.findOneAndUpdate(
      { userId: userId },
      {
        $addToSet: {
          fcmTokens: {
            token: fcmToken,
            device: deviceInfo,
            lastUsed: new Date(),
          },
        },
      },
      { upsert: true, new: true },
    );

    res.status(200).json({
      success: true,
      message: "Token registered successfully",
    });
  } catch (error) {
    console.error("Error registering token:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Send notification to specific user
app.post("/send-notification", async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    // Get user's FCM tokens
    const userTokens = await UserToken.findOne({ userId });

    if (!userTokens || userTokens.fcmTokens.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No tokens found for this user",
      });
    }

    const messages = userTokens.fcmTokens.map((tokenInfo) => ({
      notification: {
        title,
        body,
      },
      data: data || {},
      token: tokenInfo.token,
    }));

    // Send notifications and handle responses
    const responses = await Promise.all(
      messages.map(async (message) => {
        try {
          return await admin.messaging().send(message);
        } catch (error) {
          if (error.code === "messaging/invalid-registration-token" || error.code === "messaging/registration-token-not-registered") {
            // Remove invalid token
            await UserToken.updateOne({ userId }, { $pull: { fcmTokens: { token: message.token } } });
          }
          return null;
        }
      }),
    );

    const successfulSends = responses.filter((response) => response !== null);

    res.status(200).json({
      success: true,
      message: `Successfully sent ${successfulSends.length} notifications`,
      failed: messages.length - successfulSends.length,
    });
  } catch (error) {
    console.error("Error sending notification:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Send notification to multiple users
app.post("/send-bulk-notification", async (req, res) => {
  try {
    const { userIds, title, body, data } = req.body;

    const userTokens = await UserToken.find({
      userId: { $in: userIds },
    });

    if (!userTokens.length) {
      return res.status(404).json({
        success: false,
        message: "No tokens found for any users",
      });
    }

    const messages = userTokens.flatMap((user) =>
      user.fcmTokens.map((tokenInfo) => ({
        notification: {
          title,
          body,
        },
        data: data || {},
        token: tokenInfo.token,
      })),
    );

    // Send in batches of 500 (FCM limit)
    const batchSize = 500;
    const results = [];

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const batchResponses = await Promise.all(
        batch.map((message) =>
          admin
            .messaging()
            .send(message)
            .catch((error) => {
              if (error.code === "messaging/invalid-registration-token" || error.code === "messaging/registration-token-not-registered") {
                // Remove invalid tokens in background
                UserToken.updateMany({}, { $pull: { fcmTokens: { token: message.token } } }).exec();
              }
              return null;
            }),
        ),
      );
      results.push(...batchResponses);
    }

    const successfulSends = results.filter((result) => result !== null);

    res.status(200).json({
      success: true,
      message: `Successfully sent ${successfulSends.length} notifications`,
      failed: messages.length - successfulSends.length,
    });
  } catch (error) {
    console.error("Error sending bulk notifications:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(8012, () => {
  console.log("Server running on port 8012");
});
module.exports = app;
