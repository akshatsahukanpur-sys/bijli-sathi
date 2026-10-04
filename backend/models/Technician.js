const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const TechnicianSchema = new Schema({
  technicianId: {
    type: String,
    required: [true, 'Technician ID is required'],
    unique: true,
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    // allow same email with different technicianId -> different technician per instruction
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
  currentLocation: {
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: {
      type: [Number], // [lng, lat]
    },
  },
  status: {
    type: String,
    enum: ['available', 'on-task', 'offline'],
    default: 'available',
  },
  assignedComplaints: [
    {
      type: Schema.Types.ObjectId,
      ref: 'Complaint',
    },
  ],
}, { timestamps: true });

TechnicianSchema.index({ currentLocation: '2dsphere' });

module.exports = mongoose.model('Technician', TechnicianSchema);
