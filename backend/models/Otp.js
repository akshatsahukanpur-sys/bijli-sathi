const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OtpSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  otp: { type: String, required: true },
  userType: { type: String, enum: ['citizen','technician','kesco','complaint'], required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 } // auto-expire after 10 minutes (email says valid 10 min)
});

OtpSchema.index({ email: 1 });
OtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

module.exports = mongoose.model('Otp', OtpSchema);
