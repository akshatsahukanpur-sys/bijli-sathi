const mongoose = require('mongoose');
const app = require('../server.js');

// Serverless-safe DB: Vercel freezes the process between visits, so a
// background connect() started at cold start may never finish. Ensure a live
// connection inside the request (event loop stays alive), caching across warm
// invocations. Same URI/options as server.js — mongoose dedupes the call.
module.exports = async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        retryWrites: true,
      });
    }
  } catch (e) {
    console.warn('[api] DB ensure failed:', e.message);
  }
  return app(req, res);
};
