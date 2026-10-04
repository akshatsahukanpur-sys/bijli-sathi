const express = require('express');
const router = express.Router();
const Complaint = require('../models/Complaint');
const ComplaintCluster = require('../models/ComplaintCluster');
const User = require('../models/User');
const Technician = require('../models/Technician');
const { protect, authorize } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const stringSimilarity = require('string-similarity');
const cloudinary = require('cloudinary').v2;
const aiTriage = require('../services/aiTriage');

// Cloudinary config (graceful fallback if dummy creds)
try {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} catch (e) {
  console.warn('Cloudinary config warning:', e.message);
}

// Multer setup for photo upload (disk storage -> uploads folder)
// On Vercel the filesystem is read-only except /tmp, so switch there and tolerate mkdir failure
const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) { console.warn('uploads mkdir warning (vercel):', e.message); }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  }
});

// Helper: Haversine distance calculation (meters) - kept for reference but Mongo $near is primary
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * 1000;
};

// Helper: calculate genuineness score (0-1)
function calculateGenuineness({ description, photoUrl, location }) {
  let score = 0.7; // base
  if (!photoUrl || photoUrl === '') score -= 0.15;
  else score += 0.1;
  if (!location || !location.coordinates || location.coordinates.length !== 2) score -= 0.2;
  else score += 0.1;
  if (!description || description.trim().length < 10) score -= 0.15;
  if (description && description.trim().length > 30) score += 0.1;
  // Gibberish check: if description has very low alphanumeric ratio
  if (description) {
    const alphanum = (description.match(/[a-zA-Z0-9]/g) || []).length;
    const ratio = alphanum / description.length;
    if (ratio < 0.5) score -= 0.3;
    // Repeated chars like "aaaaaaa"
    if (/(.)\1{5,}/.test(description)) score -= 0.2;
  }
  // Clamp 0-1
  // No-evidence rule: NO photo + NO description → neutral, never false.
  // Only actually-wrong content is flagged; missing content stays reviewable.
  if (!photoUrl && !description) score = Math.max(score, 0.5);
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

// Helper: calculate urgency score (0-10)
function calculateUrgency(problemVariant, clusterSize = 0, genuinenessScore = 0.7) {
  let score = 0;
  const weights = {
    'transformer-fault': 5,
    'broken-wire': 4,
    'no-power': 3,
    'voltage-fluctuation': 2,
    'streetlight': 1,
    'meter-fault': 2,
    'billing': 0,
    'other': 1,
  };
  score += weights[problemVariant] || 1;
  if (clusterSize > 3) score += 3;
  else if (clusterSize > 1) score += 2;
  if (genuinenessScore < 0.3) score = Math.max(0, score - 2); // deprioritize likely false
  if (genuinenessScore > 0.8) score += 1;
  return Math.min(10, Math.max(0, score));
}

// Citizen: Submit new complaint (supports JSON with photoUrl OR multipart with file) - citizen only
router.post('/', protect, authorize('citizen'), upload.single('photo'), async (req, res) => {
  try {
    const {
      problemVariant,
      description,
      photo, // may be URL string from JSON
      location, // expected [lng, lat] or {lat,lng} or {coordinates:[lng,lat]}
      photoUrl, // alternative field name
    } = req.body;

    // Normalize userId (protect gives both id and userId)
    const userId = req.user.userId || req.user.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Invalid token payload' });

    // Validate problemVariant
    if (!problemVariant) return res.status(400).json({ success: false, error: 'problemVariant is required' });
    const ALLOWED_VARIANTS = ['no-power', 'voltage-fluctuation', 'transformer-fault', 'broken-wire', 'streetlight', 'meter-fault', 'billing', 'other'];
    if (!ALLOWED_VARIANTS.includes(String(problemVariant))) return res.status(400).json({ success: false, error: 'Invalid problemVariant' });
    if (description && String(description).length > 500) return res.status(400).json({ success: false, error: 'Description too long (max 500 chars)' });

    // Normalize location to [lng, lat] — robust: handles array, object, and JSON-stringified object (FormData sends strings)
    let coordinates;
    const parseLocationInput = (loc) => {
      if (loc == null || loc === '') return null;
      if (Array.isArray(loc)) return loc.map(Number);
      if (typeof loc === 'object') {
        if (Array.isArray(loc.coordinates)) return loc.coordinates.map(Number);
        if (loc.lat !== undefined && loc.lng !== undefined) return [Number(loc.lng), Number(loc.lat)];
        if (loc.latitude !== undefined && loc.longitude !== undefined) return [Number(loc.longitude), Number(loc.latitude)];
        if (loc.lat !== undefined && loc.lon !== undefined) return [Number(loc.lon), Number(loc.lat)];
        return null;
      }
      if (typeof loc === 'string') {
        const trimmed = loc.trim();
        if (!trimmed) return null;
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed.map(Number);
          if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.coordinates)) return parsed.coordinates.map(Number);
            if (parsed.lat !== undefined && parsed.lng !== undefined) return [Number(parsed.lng), Number(parsed.lat)];
            if (parsed.latitude !== undefined && parsed.longitude !== undefined) return [Number(parsed.longitude), Number(parsed.latitude)];
            if (parsed.lat !== undefined && parsed.lon !== undefined) return [Number(parsed.lon), Number(parsed.lat)];
          }
        } catch {}
        // Fallback: comma-separated "lat,lng" inside string
        if (trimmed.includes(',')) {
          const parts = trimmed.split(',').map((s) => Number(s.trim()));
          if (parts.length === 2 && parts.every((n) => !isNaN(n))) {
            // Heuristic: if first value ~ 20-30 (Kanpur lat) treat as lat,lng -> swap to lng,lat
            const [a, b] = parts;
            if (a >= 20 && a <= 30 && b >= 70 && b <= 90) return [b, a];
            return parts;
          }
        }
      }
      return null;
    };
    coordinates = parseLocationInput(location);

    if (!coordinates || coordinates.length !== 2 || coordinates.some(isNaN)) {
      return res.status(400).json({ success: false, error: 'Valid location [lng, lat] is required. Example: [80.3319, 26.4499]' });
    }

    // Description & photo are BOTH optional — citizen can report with only a
    // problem type + location. AI triage rates:
    //   • no photo + no description  → 35% genuine (held for KESCO review)
    //   • photo and/or description present → deeply analyzed (false/duplicate verdict)
    const cleanDesc = String(description || '').trim();
    // Basic bounds check for Kanpur region (optional, just sanity)
    const [lng, lat] = coordinates;
    if (lng < 70 || lng > 90 || lat < 20 || lat > 30) {
      console.warn(`Location out of expected range: [${lng}, ${lat}]`);
    }

    // Handle photo: priority = uploaded file > photoUrl > photo field
    let finalPhotoUrl = photoUrl || photo || '';
    if (req.file) {
      // Try Cloudinary upload if configured, else use local path
      const isCloudinaryConfigured = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name' && process.env.CLOUDINARY_API_KEY !== 'your_api_key';
      if (isCloudinaryConfigured) {
        try {
          const result = await cloudinary.uploader.upload(req.file.path, { folder: 'bijlisathi/complaints' });
          finalPhotoUrl = result.secure_url;
          // Optionally delete local file after upload
          try { fs.unlinkSync(req.file.path); } catch {}
        } catch (cloudErr) {
          console.warn('Cloudinary upload failed, using local file:', cloudErr.message);
          finalPhotoUrl = `/uploads/${path.basename(req.file.path)}`;
        }
      } else {
        finalPhotoUrl = `/uploads/${path.basename(req.file.path)}`;
      }
    }

    // Create complaint shell (AI will fill scores/eta/assignment)
    const complaint = new Complaint({
      citizenId: userId,
      problemVariant,
      description: cleanDesc,
      photoUrl: finalPhotoUrl,
      location: {
        type: 'Point',
        coordinates,
      },
      status: 'registered',
      genuinenessScore: 0.5, // placeholder, AI will recompute
      urgencyScore: 0,
    });

    await complaint.save();

    // Add to user's complaints array
    try {
      await User.findByIdAndUpdate(userId, { $push: { complaints: complaint._id } });
    } catch {}

    // ── AI Automation: full triage (photo vision + duplicate + fake + ETA + nearest-tech dispatch) ──
    const io = req.app.get('io');
    let aiResult;
    try {
      aiResult = await aiTriage.performEnhancedTriage(complaint, null, io);
    } catch (aiErr) {
      console.warn('[AI] performEnhancedTriage failed, falling back to legacy:', aiErr.message);
      // Fallback to legacy simple triage so complaint still gets scored
      const fallbackScore = calculateGenuineness({ description: cleanDesc, photoUrl: finalPhotoUrl, location: { coordinates } });
      const fallback = await performAITriage(complaint, fallbackScore);
      aiResult = {
        complaint: fallback.updatedComplaint,
        cluster: fallback.cluster,
        photoAnalysis: { isRelevant: null, confidence: 0.5, provider: 'fallback', reasoning: aiErr.message },
        genuinenessScore: fallbackScore,
        urgencyScore: fallback.updatedComplaint.urgencyScore,
        eta: null,
        assignment: { assigned: false, reason: 'AI triage fallback' },
      };
    }

    const finalComplaint = aiResult.complaint;
    const cluster = aiResult.cluster;

    // Also emit legacy events for old frontends
    if (io) {
      io.emit('complaint-updated', {
        complaintId: complaint._id,
        status: finalComplaint.status,
        clusterId: cluster ? cluster._id : null,
        etaMinutes: finalComplaint.techEtaMinutes ?? finalComplaint.etaMinutes,
        estimatedResolutionAt: finalComplaint.estimatedResolutionAt,
      });
      io.emit('new-complaint', { complaint: finalComplaint, cluster });
    }

    res.status(201).json({
      success: true,
      complaint: finalComplaint,
      cluster,
      genuinenessScore: aiResult.genuinenessScore,
      urgencyScore: aiResult.urgencyScore,
      eta: aiResult.eta,
      photoAnalysis: aiResult.photoAnalysis,
      assignment: aiResult.assignment,
      duplicateConfidence: aiResult.duplicateConfidence,
    });
  } catch (err) {
    console.error('POST /api/complaints error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get complaints for current citizen - citizen only
router.get('/my', protect, authorize('citizen'), async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const complaints = await Complaint.find({ citizenId: userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('assignedTechnicianId', 'name phone')
      .lean();
    // Duplicate-cluster members see the representative's technician/status/ETA too,
    // so every citizen of a merged report tracks the SAME job as the first reporter.
    const mirrored = await Promise.all(complaints.map((c) => attachSharedClusterTracking(c)));
    res.json({ success: true, complaints: mirrored });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Citizen: delete all own complaints — as requested "Delete all the report all the entries up till now as citizen"
router.delete('/my/clear', protect, authorize('citizen'), async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const del = await Complaint.deleteMany({ citizenId: userId });
    // Remove from clusters
    await ComplaintCluster.updateMany({}, { $pull: { memberComplaintIds: { $in: [] } } });
    // Clean clusters that become empty
    await ComplaintCluster.deleteMany({ memberComplaintIds: { $size: 0 } });
    // Clear user's complaints array
    await User.findByIdAndUpdate(userId, { $set: { complaints: [] } });
    res.json({ success: true, deleted: del.deletedCount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Citizen: delete single own complaint
router.delete('/:id', protect, authorize('citizen'), async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    const userId = String(req.user.userId || req.user.id);
    if (String(complaint.citizenId) !== userId) return res.status(403).json({ success: false, error: 'Forbidden: not your complaint' });
    await Complaint.findByIdAndDelete(req.params.id);
    await User.findByIdAndUpdate(userId, { $pull: { complaints: req.params.id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Cluster shared tracking — both citizens of the same 500m duplicate cluster see
// the SAME result, SAME technician and SAME live tracking as the representative job.
// Members keep assignedTechnicianId null in DB (single dispatch to one lineman),
// but reads mirror the representative's technician/status/ETA.
async function attachSharedClusterTracking(c) {
  try {
    if (!c || !c.isDuplicateOf) return c;
    const clusterId = c.isDuplicateOf?._id || c.isDuplicateOf;
    const cluster = await ComplaintCluster.findById(clusterId).lean();
    if (!cluster) return c;
    const repId = cluster.representativeComplaintId;
    if (!repId || String(repId) === String(c._id)) return c;
    const rep = await Complaint.findById(repId)
      .populate('assignedTechnicianId', 'name phone currentLocation status')
      .lean();
    if (!rep) return c;
    const memberCount = (cluster.memberComplaintIds || []).length || 2;
    c.sharedTracking = {
      representativeId: rep._id,
      memberCount,
      technician: rep.assignedTechnicianId || null,
      status: rep.status,
      etaMinutes: rep.etaMinutes,
      estimatedResolutionAt: rep.estimatedResolutionAt,
    };
    if (!c.assignedTechnicianId && rep.assignedTechnicianId) c.assignedTechnicianId = rep.assignedTechnicianId;
    const order = { registered: 0, working: 1, resolved: 2 };
    if ((order[rep.status] ?? 0) > (order[c.status] ?? 0)) {
      c.status = rep.status;
      if (rep.resolvedAt) c.resolvedAt = rep.resolvedAt;
      if (rep.resolutionNotes) c.resolutionNotes = rep.resolutionNotes;
    }
    if (c.etaMinutes == null && rep.etaMinutes != null) {
      c.etaMinutes = rep.etaMinutes;
      c.estimatedResolutionAt = rep.estimatedResolutionAt;
    }
    // Mirror technician-set ETA (the REAL ETA — technician reads description/photo and sets it on accept)
    if (!c.techEtaMinutes && rep.techEtaMinutes) {
      c.techEtaMinutes = rep.techEtaMinutes;
      c.techEtaLabel = rep.techEtaLabel;
      c.techEtaEstimatedAt = rep.techEtaEstimatedAt;
    }
    // Mirror the AI safety plan (generated on acceptance) to duplicate-cluster members too
    if (rep.safetyPrecautions && !c.safetyPrecautions) c.safetyPrecautions = rep.safetyPrecautions;
    if (rep.resolutionProcess && !c.resolutionProcess) c.resolutionProcess = rep.resolutionProcess;
  } catch {}
  return c;
}

// Get single complaint by ID — strict isolation
router.get('/:id', protect, async (req, res) => {
  try {
    // Fetch WITHOUT populating citizenId first: if the citizen was deleted,
    // populate() nulls the field and ownership checks would wrongly 403 the real owner.
    let complaint = await Complaint.findById(req.params.id)
      .populate('assignedTechnicianId', 'name phone currentLocation status');
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });

    const userId = String(req.user.userId || req.user.id);
    const role = (req.user.userType || '').toLowerCase();
    const ownerRaw = complaint.citizenId ? String(complaint.citizenId) : null;

    if (role === 'citizen') {
      // Citizen can only view own complaints (raw id comparison survives deleted users)
      if (!ownerRaw || ownerRaw !== userId) {
        return res.status(403).json({ success: false, error: 'Forbidden: not your complaint' });
      }
    } else if (role === 'technician') {
      // Technician can only view complaints assigned to them or unassigned pooled (if not duplicate/false)
      const assignedId = complaint.assignedTechnicianId ? String(complaint.assignedTechnicianId._id || complaint.assignedTechnicianId) : null;
      const isAssignedToMe = assignedId === userId;
      const isPooled = !complaint.assignedTechnicianId && !complaint.isDuplicateOf && (complaint.genuinenessScore == null || complaint.genuinenessScore >= 0.5);
      if (!isAssignedToMe && !isPooled) {
        return res.status(403).json({ success: false, error: 'Forbidden: not assigned to you' });
      }
    } else if (role === 'kesco') {
      // KESCO can view all
    } else {
      return res.status(403).json({ success: false, error: 'Forbidden: unknown role' });
    }

    // Populate citizen details for the response (null-safe if user was deleted)
    complaint = complaint.toObject();
    try {
      const citizen = await User.findById(ownerRaw).select('name meterNumber email').lean();
      complaint.citizenId = citizen || null;
    } catch {
      complaint.citizenId = null;
    }
    // Duplicate-cluster members share the representative's result/technician/tracking
    complaint = await attachSharedClusterTracking(complaint);

    res.json({ success: true, complaint });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Citizen: confirm resolved or reopen - citizen only + own complaint only
router.post('/:id/feedback', protect, authorize('citizen'), async (req, res) => {
  try {
    const { action } = req.body; // 'confirm' or 'reopen'
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    const userId = String(req.user.userId || req.user.id);
    if (String(complaint.citizenId) !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden: not your complaint' });
    }

    if (action === 'reopen' && complaint.status === 'resolved') {
      complaint.status = 'working';
      complaint.resolvedAt = null;
    await complaint.save();

    // Short public fault ID (FLD-A01 pattern) — same for duplicates of one fault
    try {
      const Counter = require('../models/Counter');
      const seq = await Counter.next('complaint');
      complaint.ticketId = Counter.ticketIdFromSeq(seq);
      await complaint.save();
    } catch (e) { console.warn('[ticketId] assign failed:', e.message); }
      const io = req.app.get('io');
      if (io) io.emit('complaint-status-updated', { complaintId: complaint._id, status: 'working' });
    }
    // confirm does nothing but acknowledge
    res.json({ success: true, complaint });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AI endpoints ────────────────────────────────────────────────
// Citizen: get AI triage details including ETA, photo verdict, assignment — isolated
router.get('/:id/ai-status', protect, async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id)
      .populate('assignedTechnicianId', 'name phone technicianId currentLocation status')
      .populate('isDuplicateOf');
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    const userId = String(req.user.userId || req.user.id);
    const role = (req.user.userType || '').toLowerCase();
    if (role === 'citizen' && String(complaint.citizenId) !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden: not your complaint' });
    }
    if (role === 'technician') {
      const assignedId = complaint.assignedTechnicianId ? String(complaint.assignedTechnicianId._id || complaint.assignedTechnicianId) : null;
      if (assignedId !== userId && String(complaint.citizenId) !== userId) {
        // allow if pooled? keep strict: only assigned
        const isPooled = !complaint.assignedTechnicianId && !complaint.isDuplicateOf;
        if (!isPooled) return res.status(403).json({ success: false, error: 'Forbidden' });
      }
    }
    // Duplicate-cluster members share the representative's result/technician/tracking
    const shared = await attachSharedClusterTracking(complaint.toObject());
    // Technician-set ETA is the REAL estimate — AI does NOT set any repair time
    const techEta = shared.techEtaMinutes || shared.etaMinutes;
    const techLabel = shared.techEtaLabel || (techEta != null
      ? techEta < 60 ? `~${techEta} mins` : `~${Math.round(techEta / 60)} hrs`
      : null);
    res.json({
      success: true,
      ai: {
        processed: shared.aiProcessed,
        genuinenessScore: shared.genuinenessScore,
        urgencyScore: shared.urgencyScore,
        isDuplicate: !!shared.isDuplicateOf,
        duplicateConfidence: shared.duplicateConfidence,
        clusterId: shared.isDuplicateOf,
        sharedTracking: shared.sharedTracking || null,
        etaMinutes: techEta,
        estimatedResolutionAt: shared.techEtaEstimatedAt || shared.estimatedResolutionAt,
        etaLabel: techLabel,
        techEtaMinutes: shared.techEtaMinutes || null,
        techEtaLabel: shared.techEtaLabel || '',
        photoAnalysis: shared.aiPhotoAnalysis,
        status: shared.status,
        assignedTechnician: shared.assignedTechnicianId,
        assignedAt: shared.assignedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// KESCO or citizen: request re-triage — citizen only own, kesco any
router.post('/:id/re-triage', protect, async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    const userId = String(req.user.userId || req.user.id);
    const role = (req.user.userType || '').toLowerCase();
    if (role === 'citizen' && String(complaint.citizenId) !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden: not your complaint' });
    }
    if (role === 'technician') {
      return res.status(403).json({ success: false, error: 'Forbidden: technicians cannot re-triage' });
    }
    const io = req.app.get('io');
    const result = await aiTriage.performEnhancedTriage(complaint, null, io);
    res.json({ success: true, complaint: result.complaint, photoAnalysis: result.photoAnalysis, eta: result.eta, assignment: result.assignment });
  } catch (err) {
    console.error('re-triage error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper function for AI triage (legacy fallback)
async function performAITriage(complaint, genuinenessScore) {
  const radiusMeters = 500; // 500m clustering radius — same issue + same location = one cluster job
  const timeWindowHours = 2; // 2-hour window

  let cluster = null;
  let nearbyComplaints = [];

  try {
    // Find complaints within radius and time window with same problem variant, excluding self
    nearbyComplaints = await Complaint.find({
      _id: { $ne: complaint._id },
      problemVariant: complaint.problemVariant,
      status: { $in: ['registered', 'working'] },
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: complaint.location.coordinates,
          },
          $maxDistance: radiusMeters, // for 2dsphere, meters directly
        },
      },
      createdAt: {
        $gte: new Date(Date.now() - timeWindowHours * 60 * 60 * 1000),
      },
    }).limit(50);
  } catch (geoErr) {
    console.warn('Geo query failed (index may be missing):', geoErr.message);
    // Fallback: no clustering if geo fails
    nearbyComplaints = [];
  }

  // Text similarity check
  let textMatchCount = 0;
  if (nearbyComplaints.length > 0) {
    const complaintText = (complaint.description || '').toLowerCase();
    if (complaintText.trim().length > 5) {
      nearbyComplaints.forEach((c) => {
        if (c.description && c.description.trim().length > 5) {
          const similarity = stringSimilarity.compareTwoStrings(
            complaintText,
            c.description.toLowerCase()
          );
          if (similarity > 0.6) textMatchCount++;
        }
      });
    }
  }

  // RELAXED: any same-variant within 500m+2h is considered duplicate cluster (KESCO colony-level)
  const shouldCluster = nearbyComplaints.length >= 1;

  if (shouldCluster) {
    // Try to find existing cluster that already contains one of the nearby complaints
    const nearbyIds = nearbyComplaints.map(c => c._id);
    let existingCluster = await ComplaintCluster.findOne({
      memberComplaintIds: { $in: nearbyIds },
      problemVariant: complaint.problemVariant,
      status: 'active',
    });

    if (existingCluster) {
      // Add this complaint to existing cluster
      if (!existingCluster.memberComplaintIds.some(id => id.equals(complaint._id))) {
        existingCluster.memberComplaintIds.push(complaint._id);
        existingCluster.reportCount = existingCluster.memberComplaintIds.length;
        // Update centroid incrementally
        const allCoords = [...nearbyComplaints.map(c => c.location.coordinates), complaint.location.coordinates];
        const avgLng = allCoords.reduce((sum, coord) => sum + coord[0], 0) / allCoords.length;
        const avgLat = allCoords.reduce((sum, coord) => sum + coord[1], 0) / allCoords.length;
        existingCluster.locationCentroid = { type: 'Point', coordinates: [avgLng, avgLat] };
        await existingCluster.save();
      }
      cluster = existingCluster;
      // Mark this complaint as duplicate
      complaint.isDuplicateOf = cluster._id;
    } else {
      // Create new cluster with this complaint + nearby complaints
      const allCoords = [...nearbyComplaints.map(c => c.location.coordinates), complaint.location.coordinates];
      const avgLng = allCoords.reduce((sum, coord) => sum + coord[0], 0) / allCoords.length;
      const avgLat = allCoords.reduce((sum, coord) => sum + coord[1], 0) / allCoords.length;

      cluster = new ComplaintCluster({
        representativeComplaintId: nearbyComplaints[0] ? nearbyComplaints[0]._id : complaint._id,
        memberComplaintIds: [...nearbyIds, complaint._id],
        locationCentroid: { type: 'Point', coordinates: [avgLng, avgLat] },
        problemVariant: complaint.problemVariant,
        reportCount: nearbyIds.length + 1,
        status: 'active',
      });
      await cluster.save();

      // Mark all member complaints as duplicate (except representative stays primary)
      // For simplicity, mark all as duplicate of cluster but keep representative as reference
      const idsToMark = [...nearbyIds, complaint._id];
      await Complaint.updateMany(
        { _id: { $in: idsToMark } },
        { isDuplicateOf: cluster._id }
      );
      // Reload complaint to get updated isDuplicateOf
      complaint.isDuplicateOf = cluster._id;
    }
  }

  // Calculate urgency score
  const clusterSize = cluster ? cluster.reportCount : nearbyComplaints.length + 1;
  const urgencyScore = calculateUrgency(complaint.problemVariant, clusterSize, genuinenessScore);

  complaint.urgencyScore = urgencyScore;
  complaint.genuinenessScore = genuinenessScore;
  await complaint.save();

  return { complaint: complaint, cluster, updatedComplaint: complaint };
}

module.exports = router;
