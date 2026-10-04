const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ComplaintSchema = new Schema({
  ticketId: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
  },
  citizenId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Citizen ID is required'],
  },
  technicianId: {
    type: Schema.Types.ObjectId,
    ref: 'Technician',
  },
  KESCOAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'KESCOAdmin',
  },
  problemVariant: {
    type: String,
    enum: [
      'no-power',
      'voltage-fluctuation',
      'transformer-fault',
      'broken-wire',
      'streetlight',
      'meter-fault',
      'billing',
      'other',
    ],
    required: [true, 'Problem variant is required'],
  },
  description: {
    type: String,
    default: '',
  },
  photoUrl: {
    type: String,
    default: '',
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [lng, lat]
      required: true,
    },
  },
  status: {
    type: String,
    enum: ['registered', 'working', 'resolved'],
    default: 'registered',
  },
  isDuplicateOf: {
    type: Schema.Types.ObjectId,
    ref: 'ComplaintCluster',
    default: null,
  },
  genuinenessScore: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.7, // default genuine if not scored; ensures technician queue not empty
  },
  urgencyScore: {
    type: Number,
    min: 0,
    max: 10,
    default: 0,
  },
  assignedTechnicianId: {
    type: Schema.Types.ObjectId,
    ref: 'Technician',
    default: null,
  },
  // AI recommends the nearest technician to the KESCO Commander — task is only
  // dispatched to the technician after the Commander assigns it.
  recommendedTechnicianId: {
    type: Schema.Types.ObjectId,
    ref: 'Technician',
    default: null,
  },
  recommendedDistanceKm: {
    type: Number,
    default: null,
  },
  recommendedAt: {
    type: Date,
    default: null,
  },
  resolvedAt: {
    type: Date,
    default: null,
  },
  resolutionPhotoUrl: {
    type: String,
    default: '',
  },
  resolutionNotes: {
    type: String,
    default: '',
  },
  isDismissed: {
    type: Boolean,
    default: false,
  },
  dismissedAt: {
    type: Date,
    default: null,
  },
  dismissedBy: {
    type: Schema.Types.ObjectId,
    ref: 'KESCOAdmin',
    default: null,
  },
  // ── AI Automation fields ──────────────────────────────────
  etaMinutes: {
    type: Number,
    default: null,
    min: 0,
  },
  estimatedResolutionAt: {
    type: Date,
    default: null,
  },
  // ── Technician-set ETA (after the technician accepts, reads description + photo) ──
  techEtaMinutes: {
    type: Number,
    default: null,
    min: 0,
  },
  techEtaLabel: {
    type: String,
    default: '',
  },
  techEtaEstimatedAt: {
    type: Date,
    default: null,
  },
  // ── AI safety plan (generated when the technician accepts the task) ──
  safetyPrecautions: {
    type: String,
    default: '',
  },
  resolutionProcess: {
    type: String,
    default: '',
  },
  safetyPlanGeneratedAt: {
    type: Date,
    default: null,
  },
  assignedAt: {
    type: Date,
    default: null,
  },
  aiProcessed: {
    type: Boolean,
    default: false,
  },
  duplicateConfidence: {
    type: Number,
    min: 0,
    max: 1,
    default: null,
  },
  aiPhotoAnalysis: {
    isRelevant: { type: Boolean, default: null },
    confidence: { type: Number, min: 0, max: 1, default: null },
    tags: { type: [String], default: [] },
    reasoning: { type: String, default: '' },
    provider: { type: String, default: 'heuristic' },
    analyzedAt: { type: Date, default: null },
    // High-level AI extras (Gemini 2.0 Flash / GPT-4o)
    severity: { type: String, enum: ['low','medium','high','critical'], default: 'medium' },
    detectedFault: { type: String, default: '' },
    safetyAdvice: { type: String, default: '' },
    estimatedMinutes: { type: Number, default: null },
    model: { type: String, default: 'heuristic' },
    level: { type: String, default: 'heuristic' },
  },
  duplicateSemantic: {
    maxSimilarity: { type: Number, default: null },
    maxSemantic: { type: Number, default: null },
    semanticProvider: { type: String, default: null },
    geminiJudgeResult: { type: Schema.Types.Mixed, default: null },
  },
}, { timestamps: true }); // timestamps adds createdAt and updatedAt automatically

ComplaintSchema.index({ location: '2dsphere' });
ComplaintSchema.index({ status: 1 });
ComplaintSchema.index({ problemVariant: 1 });
ComplaintSchema.index({ citizenId: 1 });
ComplaintSchema.index({ assignedTechnicianId: 1 });
ComplaintSchema.index({ createdAt: -1 });
// Performance: compound indexes for common filtered queries (fixes lag on KESCO polling)
ComplaintSchema.index({ citizenId: 1, createdAt: -1 });
ComplaintSchema.index({ assignedTechnicianId: 1, status: 1 });
ComplaintSchema.index({ status: 1, genuinenessScore: 1, isDuplicateOf: 1 });
ComplaintSchema.index({ genuinenessScore: 1, isDuplicateOf: 1, status: 1 });
ComplaintSchema.index({ 'aiPhotoAnalysis.isRelevant': 1 });
ComplaintSchema.index({ isDismissed: 1, status: 1 });

module.exports = mongoose.model('Complaint', ComplaintSchema);
