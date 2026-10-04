const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ComplaintClusterSchema = new Schema({
  representativeComplaintId: {
    type: Schema.Types.ObjectId,
    ref: 'Complaint',
    required: true,
  },
  memberComplaintIds: [
    {
      type: Schema.Types.ObjectId,
      ref: 'Complaint',
    },
  ],
  locationCentroid: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [lng, lat]
      default: [0, 0],
    },
  },
  problemVariant: {
    type: String,
    required: true,
  },
  reportCount: {
    type: Number,
    default: 1,
  },
  status: {
    type: String,
    enum: ['active', 'resolved'],
    default: 'active',
  },
}, { timestamps: true });

ComplaintClusterSchema.index({ locationCentroid: '2dsphere' });
ComplaintClusterSchema.index({ status: 1 });
ComplaintClusterSchema.index({ problemVariant: 1 });

module.exports = mongoose.model('ComplaintCluster', ComplaintClusterSchema);
