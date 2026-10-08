const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OtpSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  otp: { type: String, required: true },
  userType: { type: String, enum: ['citizen','technician','kesco','complaint'], required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  // TTL 10 min is a safety net only — verify-otp enforces the real 5-min expiry
  createdAt: { type: Date, default: Date.now, expires: 600 }
});

module.exports = mongoose.model('Otp', OtpSchema);
