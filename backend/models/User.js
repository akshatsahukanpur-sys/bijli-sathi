const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  meterNumber: {
    type: String,
    required: [true, 'Meter number is required'],
    unique: true,
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    // allow same email with different meterNumber -> different person per instruction
    // meterNumber is the primary isolation key, email is just for OTP
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  name: {
    type: String,
    default: '',
    trim: true,
  },
  phone: {
    type: String,
    default: '',
  },
  savedLocations: [
    {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [lng, lat]
      },
    },
  ],
  complaints: [
    {
      type: Schema.Types.ObjectId,
      ref: 'Complaint',
    },
  ],
}, { timestamps: true });

// 2dsphere for geo queries if needed
UserSchema.index({ 'savedLocations': '2dsphere' });

module.exports = mongoose.model('User', UserSchema);
