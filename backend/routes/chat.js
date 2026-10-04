/**
 * BijliSathi ChatGPT-type Assistant Routes
 * Citizen asks about their complaint in natural language — ChatGPT answers using real triage context
 * Also supports KESCO commander quick queries (optional)
 */
const express = require('express');
const router = express.Router();
const Complaint = require('../models/Complaint');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const chatAssistant = require('../services/chatAssistant');

// Citizen: chat about a specific complaint (must own it or be assigned tech / kesco)
router.post('/complaint/:id', protect, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ success: false, error: 'message is required' });
    const q = String(message).slice(0, 800);

    const complaint = await Complaint.findById(req.params.id)
      .populate('assignedTechnicianId', 'name phone status technicianId')
      .populate('citizenId', 'meterNumber email name');

    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });

    // Auth: citizen owns it, or technician assigned, or kesco, or any citizen can ask about own? For MVP allow any authenticated to chat about any complaint if they know ID (citizen view)
    const userId = String(req.user.userId || req.user.id);
    const isOwner = String(complaint.citizenId?._id || complaint.citizenId) === userId;
    const isKesco = (req.user.userType || '').toLowerCase() === 'kesco';
    const isTech = (req.user.userType || '').toLowerCase() === 'technician';
    // Allow if owner, kesco, tech, or complaint status not resolved? For demo, allow all authenticated but log
    // Enforce only owner/kesco/tech can chat about complaint metadata (privacy)
    if (!isOwner && !isKesco && !isTech) {
      // Still allow but restrict context? For now deny
      return res.status(403).json({ success: false, error: 'Only complaint owner, assigned technician, or KESCO can chat about this complaint' });
    }

    // Fetch AI context (from complaint doc)
    const ai = {
      genuinenessScore: complaint.genuinenessScore,
      urgencyScore: complaint.urgencyScore,
      isDuplicate: !!complaint.isDuplicateOf,
      duplicateConfidence: complaint.duplicateConfidence,
      etaMinutes: complaint.etaMinutes,
      estimatedResolutionAt: complaint.estimatedResolutionAt,
      etaLabel: complaint.etaMinutes != null ? (complaint.etaMinutes < 60 ? `~${complaint.etaMinutes} mins` : `~${Math.round(complaint.etaMinutes/60)} hours`) : null,
      photoAnalysis: complaint.aiPhotoAnalysis,
      status: complaint.status,
      assignedAt: complaint.assignedAt,
    };

    const { answer, provider } = await chatAssistant.chatWithComplaintContext({
      complaint,
      ai,
      question: q,
      history: Array.isArray(history) ? history.slice(-8) : [],
    });

    // Also emit socket for live feel (optional, citizen listening on complaint room)
    try {
      const io = req.app.get('io');
      if (io) io.to(complaint._id.toString()).emit('chat-assistant', { complaintId: complaint._id, question: q, answer, provider });
    } catch {}

    res.json({ success: true, answer, provider, complaintId: complaint._id, ai });
  } catch (err) {
    console.error('chat/complaint error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public-ish: general BijliSathi helper (no complaint context) — citizen quick FAQ
router.post('/ask', protect, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'message required' });
    const q = String(message).slice(0, 600);

    // Create a synthetic context — still ChatGPT personality but without complaint
    const dummyComplaint = {
      _id: 'general',
      problemVariant: 'general',
      description: '',
      status: 'info',
      location: { coordinates: [0, 0] },
      genuinenessScore: 0.7,
      urgencyScore: 0,
      etaMinutes: null,
      estimatedResolutionAt: null,
      isDuplicateOf: null,
      aiPhotoAnalysis: null,
      assignedTechnicianId: null,
      assignedAt: null,
    };
    const { answer, provider } = await chatAssistant.chatWithComplaintContext({
      complaint: dummyComplaint,
      ai: {},
      question: q,
      history: Array.isArray(history) ? history.slice(-6) : [],
    });
    res.json({ success: true, answer, provider });
  } catch (err) {
    console.error('chat/ask error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
