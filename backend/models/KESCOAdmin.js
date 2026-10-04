const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const KESCOAdminSchema = new Schema({
  registrationNumber: {
    type: String,
    required: [true, 'KESCO registration number is required'],
    unique: true,
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    // allow same email with different registrationNumber -> different KESCO admin per instruction
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  phone: {
    type: String,
    default: '',
    trim: true,
  },
  name: {
    type: String,
    default: '',
    trim: true,
  },
  role: {
    type: String,
    enum: ['operator', 'admin', 'superadmin'],
    default: 'operator',
  },
  zone: {
    type: String,
    default: '',
  },
}, { timestamps: true });

module.exports = mongoose.model('KESCOAdmin', KESCOAdminSchema);
