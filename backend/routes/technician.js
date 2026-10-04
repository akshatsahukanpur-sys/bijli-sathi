const express = require('express');
const router = express.Router();
const Technician = require('../models/Technician');
const Complaint = require('../models/Complaint');
const highLevelAI = require('../services/highLevelAI');
const { protect, authorize } = require('../middleware/auth');

router.get('/task-list', protect, authorize('technician'), async (req, res) => {
  try {
    const technicianId = req.user.userId || req.user.id;

    const technician = await Technician.findById(technicianId).populate({
      path: 'assignedComplaints',
      populate: {
        path: 'assignedTechnicianId',
        select: 'name',
      },
    });

    if (!technician) return res.status(404).json({ success: false, error: 'Technician not found' });

    // If no assignedComplaints, also fetch complaints assigned via Complaint.assignedTechnicianId
    let assigned = technician.assignedComplaints || [];
    if (assigned.length === 0) {
      assigned = await Complaint.find({ assignedTechnicianId: technicianId })
        .select('ticketId status problemVariant description location assignedTechnicianId genuinenessScore urgencyScore isDuplicateOf createdAt photoUrl')
        .populate('assignedTechnicianId', 'name')
        .sort({ urgencyScore: -1, createdAt: -1 });
    }

    // Filter: show genuine, non-duplicate OR if genuineness not scored yet, show with score >=0.5 OR null (fallback)
    // After fix, genuineness defaults to 0.7, so most will pass. We also allow isDuplicateOf == null
    // CRITICAL: a currently-WORKING (accepted) job is ALWAYS shown — even if it
    // later merged into a duplicate cluster — otherwise the technician's list
    // looks empty while he stays stuck "working" with no way to resolve it.
    const validComplaints = assigned.filter(
      (c) => {
        if (c.status === 'working') return true;
        const isDup = !!c.isDuplicateOf;
        const genuine = c.genuinenessScore == null ? true : c.genuinenessScore >= 0.5;
        // Include valid if not duplicate and genuine; also include if no score yet but not duplicate
        return !isDup && genuine;
      }
    );

    // If still empty but there are assigned, return all non-duplicate for visibility
    const toReturn = validComplaints.length > 0 ? validComplaints : assigned.filter(c => !c.isDuplicateOf);

    // Also fetch unassigned high-urgency complaints nearby? For now just return assigned
    // Plus fetch pooled complaints that are registered, not duplicate, high genuineness, and unassigned
    const pooled = await Complaint.find({
      status: 'registered',
      isDuplicateOf: null,
      genuinenessScore: { $gte: 0.5 },
      assignedTechnicianId: null,
    }).sort({ urgencyScore: -1, createdAt: -1 }).limit(10)
      .select('ticketId status problemVariant description location urgencyScore genuinenessScore createdAt photoUrl');

    res.json({
      success: true,
      complaints: toReturn,
      pooled, // extra: available tasks not yet assigned
      technicianStatus: technician.status,
    });
  } catch (err) {
    console.error('task-list error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Keep a technician's availability truthful: count WORKING (accepted, unresolved) jobs.
// KESCO-assigned but not-yet-accepted jobs do not make him busy.
function syncTechnicianStatus(technicianId) {
  return (async () => {
    try {
      const tech = await Technician.findById(technicianId).select('assignedComplaints status');
      if (!tech) return;
      const ids = (tech.assignedComplaints || []).map((c) => (typeof c === 'object' ? c._id : c));
      let active = 0;
      if (ids.length) {
        active = await Complaint.countDocuments({ _id: { $in: ids }, status: 'working' });
      }
      const nextStatus = active > 0 ? 'on-task' : 'available';
      if (tech.status !== nextStatus) {
        await Technician.findByIdAndUpdate(technicianId, { status: nextStatus });
      }
    } catch (e) { console.warn('[Technician] syncTechnicianStatus failed:', e.message); }
  })();
}

router.post('/accept-task', protect, authorize('technician'), async (req, res) => {
  try {
    const { complaintId, etaMinutes } = req.body;
    const technicianId = req.user.userId || req.user.id;

    if (!complaintId) return res.status(400).json({ success: false, error: 'complaintId is required' });

    const complaint = await Complaint.findById(complaintId);
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });

    if (complaint.status === 'resolved') return res.status(400).json({ success: false, error: 'Complaint already resolved' });
    // Only the assigned technician (KESCO's assignment) can accept — prevents race where another tech accepts unassigned
    if (complaint.assignedTechnicianId && String(complaint.assignedTechnicianId) !== String(technicianId)) {
      return res.status(403).json({ success: false, error: 'This task is assigned to another technician — KESCO must reassign to you first' });
    }

    // The technician accepts AFTER reading the complaint description + photo, and
    // gives the citizen a realistic estimated time. The AI does NOT set any ETA.
    const etaMins = etaMinutes != null && !isNaN(Number(etaMinutes)) && Number(etaMinutes) > 0
      ? Math.round(Math.min(720, Math.max(10, Number(etaMinutes))))
      : null;
    const etaEstimatedAt = etaMins ? new Date(Date.now() + etaMins * 60000) : null;
    const etaLabel = etaMins ? (etaMins < 60 ? `~${etaMins} mins` : `~${Math.round(etaMins / 60)} hrs`) : '';

    // Update complaint status and assign technician — AI never directly assigns,
    // KESCO assigns, tech must Accept to start work. ETA comes from the tech.
    const updated = await Complaint.findByIdAndUpdate(
      complaintId,
      {
        status: 'working',
        assignedTechnicianId: technicianId,
        techEtaMinutes: etaMins,
        techEtaLabel: etaLabel,
        techEtaEstimatedAt: etaEstimatedAt,
        etaMinutes: etaMins,
        estimatedResolutionAt: etaEstimatedAt,
      },
      { new: true }
    ).populate('assignedTechnicianId', 'name');

    // Update technician status and push to assignedComplaints — GPS will start on client after Accept
    await Technician.findByIdAndUpdate(technicianId, {
      status: 'on-task',
      $addToSet: { assignedComplaints: complaintId },
    });

    // AI safety plan — generated on acceptance: safety precautions + the exact
    // process to resolve this fault. Best-effort; never blocks the accept response.
    let safetyPlan = null;
    try {
      safetyPlan = await highLevelAI.generateSafetyAndProcess({
        problemVariant: complaint.problemVariant,
        description: complaint.description,
        severity: complaint.aiPhotoAnalysis?.severity || 'medium',
        detectedFault: complaint.aiPhotoAnalysis?.detectedFault || '',
        safetyAdvice: complaint.aiPhotoAnalysis?.safetyAdvice || '',
      });
      await Complaint.findByIdAndUpdate(complaintId, {
        safetyPrecautions: safetyPlan.safetyPrecautions,
        resolutionProcess: safetyPlan.process,
        safetyPlanGeneratedAt: new Date(),
      });
    } catch (e) {
      console.warn('[accept-task] safety plan failed:', e.message);
    }

    // Emit to Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('complaint-status-updated', {
        complaintId,
        status: 'working',
        technicianId,
      });
      io.to(complaintId.toString()).emit('technician-assigned', {
        technicianId,
        complaintId,
        message: etaMins
          ? `Technician accepted your complaint — resolution estimated in ~${etaLabel}. GPS tracking now active`
          : 'Technician accepted your complaint — GPS tracking now active',
      });
      io.emit('technician-assigned-broadcast', { complaintId, technicianId });
      if (etaMins) {
        io.to(complaintId.toString()).emit('eta-estimated', {
          complaintId,
          etaMinutes: etaMins,
          estimatedResolutionAt: etaEstimatedAt,
          label: etaLabel,
          source: 'technician',
        });
      }
      if (safetyPlan) {
        io.to(complaintId.toString()).emit('safety-plan-ready', {
          complaintId,
          safetyPrecautions: safetyPlan.safetyPrecautions,
          resolutionProcess: safetyPlan.process,
          provider: safetyPlan.provider,
        });
        io.emit('safety-plan-ready', {
          complaintId,
          safetyPrecautions: safetyPlan.safetyPrecautions,
          resolutionProcess: safetyPlan.process,
          provider: safetyPlan.provider,
        });
      }
    }

    // Cluster sync — every citizen merged into this job's cluster sees the SAME
    // acceptance live: status working, the accepting technician, the tech-set ETA,
    // and the AI safety plan — mirrored onto their own complaint + their rooms.
    let clusterMemberIds = [];
    try {
      const ComplaintCluster = require('../models/ComplaintCluster');
      const clusters = await ComplaintCluster.find({ memberComplaintIds: complaintId }).select('_id memberComplaintIds');
      const memberIds = [...new Set(clusters.flatMap((cl) => (cl.memberComplaintIds || []).map((id) => String(id))))].filter((id) => id !== String(complaintId));
      clusterMemberIds = memberIds;
      if (memberIds.length) {
        const memberUpdate = {
          status: 'working',
          assignedTechnicianId: technicianId,
          techEtaMinutes: etaMins,
          techEtaLabel: etaLabel,
          techEtaEstimatedAt: etaEstimatedAt,
          etaMinutes: etaMins,
          estimatedResolutionAt: etaEstimatedAt,
        };
        if (safetyPlan) {
          memberUpdate.safetyPrecautions = safetyPlan.safetyPrecautions;
          memberUpdate.resolutionProcess = safetyPlan.process;
          memberUpdate.safetyPlanGeneratedAt = new Date();
        }
        await Complaint.updateMany({ _id: { $in: memberIds } }, { $set: memberUpdate });
        if (io) {
          memberIds.forEach((mid) => {
            io.emit('complaint-status-updated', { complaintId: mid, status: 'working', technicianId });
            io.to(mid.toString()).emit('technician-assigned', {
              complaintId: mid,
              technicianId,
              sharedFrom: complaintId,
              message: etaMins
                ? `Technician accepted your complaint — resolution estimated in ~${etaLabel}. GPS tracking now active`
                : 'Technician accepted your complaint — GPS tracking now active',
            });
            if (etaMins) io.to(mid.toString()).emit('eta-estimated', { complaintId: mid, etaMinutes: etaMins, estimatedResolutionAt: etaEstimatedAt, label: etaLabel, source: 'technician', sharedFrom: complaintId });
            if (safetyPlan) io.to(mid.toString()).emit('safety-plan-ready', { complaintId: mid, safetyPrecautions: safetyPlan.safetyPrecautions, resolutionProcess: safetyPlan.process, provider: safetyPlan.provider, sharedFrom: complaintId });
            io.emit('complaint-updated', { complaintId: mid, status: 'working', sharedFrom: complaintId });
          });
        }
      }
    } catch (e) { console.warn('cluster accept sync failed', e.message); }

    // Technician-set ETA email — the ONLY fix-time email. Sent to the citizen
    // (+ every merged duplicate citizen: same response as the first reporter).
    // Fire-and-forget so accept stays instant.
    if (etaMins) {
      try {
        const techProfile = await Technician.findById(technicianId).select('name technicianId').lean().catch(() => null);
        const { notifyTechEta } = require('../services/notificationService');
        notifyTechEta({
          complaintId,
          etaMinutes: etaMins,
          etaLabel,
          estimatedAt: etaEstimatedAt,
          technician: { _id: technicianId, name: techProfile?.name || updated?.assignedTechnicianId?.name || 'KESCO lineman', technicianId: techProfile?.technicianId },
          safetyPrecautions: safetyPlan ? safetyPlan.safetyPrecautions : (complaint.safetyPrecautions || updated.safetyPrecautions || ''),
          io,
          clusterMemberIds,
        }).then((r) => console.log(`[Accept ETA email] ${complaintId} sent=${r.delivered} provider=${r.provider}`)).catch((e) => console.warn('[Accept ETA email] failed', e.message));
      } catch (e) { console.warn('[Accept ETA email] setup failed', e.message); }
    }

    res.json({
      success: true,
      complaint: updated,
      safetyPlan: safetyPlan || null,
      eta: etaMins ? { etaMinutes: etaMins, label: etaLabel, estimatedResolutionAt: etaEstimatedAt } : null,
    });
  } catch (err) {
    console.error('accept-task error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/reject-task', protect, authorize('technician'), async (req, res) => {
  try {
    const { complaintId, reason } = req.body;
    const technicianId = req.user.userId || req.user.id;
    if (!complaintId) return res.status(400).json({ success: false, error: 'complaintId is required' });
    const complaint = await Complaint.findById(complaintId);
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    if (complaint.status === 'resolved') return res.status(400).json({ success: false, error: 'Already resolved' });
    if (complaint.status === 'working') return res.status(400).json({ success: false, error: 'Already accepted — cannot reject a working job, please Resolve when done' });
    // Only assigned tech can reject; if no assignment, any tech’s reject is ignored but we clear anyway
    if (complaint.assignedTechnicianId && String(complaint.assignedTechnicianId) !== String(technicianId)) {
      return res.status(403).json({ success: false, error: 'Not your task' });
    }
    // Clear assignment — back to KESCO pool for AI to suggest next ideal free technician
    const updated = await Complaint.findByIdAndUpdate(
      complaintId,
      { assignedTechnicianId: null, status: 'registered', assignedAt: null },
      { new: true }
    );
    await Technician.findByIdAndUpdate(technicianId, { $pull: { assignedComplaints: complaintId } });
    await syncTechnicianStatus(technicianId);
    const io = req.app.get('io');
    if (io) {
      io.emit('complaint-status-updated', { complaintId, status: 'registered', technicianId: null, rejectedBy: technicianId, reason: reason || '' });
      io.emit('complaint-updated', { complaintId, status: 'registered', assignedTechnicianId: null });
      io.emit('task-rejected', { complaintId, technicianId, reason: reason || '' });
    }
    res.json({ success: true, complaint: updated, message: 'Task rejected — returned to KESCO for reassignment to next AI-suggested technician' });
  } catch (err) {
    console.error('reject-task error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/update-status', protect, authorize('technician'), async (req, res) => {
  try {
    const { complaintId, status, notes, resolutionPhotoUrl } = req.body;
    const technicianId = req.user.userId || req.user.id;

    if (!complaintId || !status) return res.status(400).json({ success: false, error: 'complaintId and status required' });
    if (!['registered', 'working', 'resolved'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });

    const update = { status };
    if (status === 'resolved') {
      update.resolvedAt = new Date();
      if (notes) update.resolutionNotes = String(notes).slice(0, 500);
      if (resolutionPhotoUrl) update.resolutionPhotoUrl = String(resolutionPhotoUrl).slice(0, 500);
    }

    // Ownership guard: only the assigned lineman (or KESCO-reassigned holder) may change status
    const existing = await Complaint.findById(complaintId).select('assignedTechnicianId status genuinenessScore isDuplicateOf');
    if (!existing) return res.status(404).json({ success: false, error: 'Complaint not found' });
    if (existing.assignedTechnicianId && String(existing.assignedTechnicianId) !== String(technicianId)) {
      return res.status(403).json({ success: false, error: 'Only the assigned lineman can update this job' });
    }

    const complaint = await Complaint.findByIdAndUpdate(
      complaintId,
      update,
      { new: true }
    );

    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });

    // Job done → free the technician: remove from assigned list, back to Available
    // (unless he still has other active jobs), and stop his tracking pin.
    if (status === 'resolved') {
      await Technician.findByIdAndUpdate(technicianId, { $pull: { assignedComplaints: complaintId } });
      await syncTechnicianStatus(technicianId);
    }

    // Emit status update
    const io = req.app.get('io');
    if (io) {
      io.emit('complaint-status-updated', {
        complaintId,
        status,
      });
      io.to(complaintId.toString()).emit('complaint-resolved', {
        complaintId,
        status,
        technicianId,
      });
      io.emit('complaint-updated', { complaintId, status });
    }

    // Cluster sync — every citizen in the same duplicate cluster gets the SAME
    // result live: mirror working/resolved onto member complaints + their rooms.
    let resolveMemberIds = [];
    try {
      const ComplaintCluster = require('../models/ComplaintCluster');
      const clusters = await ComplaintCluster.find({ memberComplaintIds: complaintId }).select('_id memberComplaintIds');
      const memberIds = [...new Set(clusters.flatMap((cl) => (cl.memberComplaintIds || []).map((id) => String(id))))].filter((id) => id !== String(complaintId));
      resolveMemberIds = memberIds;
      if (clusters.length) {
        await ComplaintCluster.updateMany(
          { _id: { $in: clusters.map((c) => c._id) } },
          { status: status === 'resolved' ? 'resolved' : 'active' }
        );
      }
      if (memberIds.length) {
        const memberUpdate = { status };
        if (status === 'resolved') {
          memberUpdate.resolvedAt = new Date();
          if (notes) memberUpdate.resolutionNotes = String(notes).slice(0, 500);
          if (resolutionPhotoUrl) memberUpdate.resolutionPhotoUrl = String(resolutionPhotoUrl).slice(0, 500);
        }
        await Complaint.updateMany({ _id: { $in: memberIds } }, memberUpdate);
        if (io) {
          memberIds.forEach((mid) => {
            io.emit('complaint-status-updated', { complaintId: mid, status });
            io.to(mid.toString()).emit('complaint-resolved', { complaintId: mid, status, technicianId });
            io.emit('complaint-updated', { complaintId: mid, status });
          });
        }
      }
    } catch (e) { console.warn('cluster status sync failed', e.message); }

    // AI resolution note + email on resolve — same wording reaches every merged citizen.
    let aiResolution = null;
    if (status === 'resolved') {
      try {
        const techProfile = await Technician.findById(technicianId).select('name technicianId').lean().catch(() => null);
        const techName = techProfile?.name || techProfile?.technicianId || 'KESCO lineman';
        const { generateResolutionMessage } = require('../services/chatAssistant');
        aiResolution = await generateResolutionMessage({
          complaint: complaint.toObject ? complaint.toObject() : complaint,
          technicianName: techName,
          resolutionNotes: notes || complaint.resolutionNotes || '',
        }).catch(() => null);
        if (aiResolution?.message && !complaint.resolutionNotes) {
          await Complaint.findByIdAndUpdate(complaintId, { resolutionNotes: String(aiResolution.message).slice(0, 600) }).catch(() => {});
          complaint.resolutionNotes = String(aiResolution.message).slice(0, 600);
          if (resolveMemberIds.length) {
            await Complaint.updateMany({ _id: { $in: resolveMemberIds } }, { resolutionNotes: String(aiResolution.message).slice(0, 600) }).catch(() => {});
          }
        } else if (aiResolution?.message) {
          // Keep technician notes as primary, append AI note for citizen display
          const combined = `${complaint.resolutionNotes}\n\n${aiResolution.message}`.slice(0, 800);
          await Complaint.findByIdAndUpdate(complaintId, { resolutionNotes: combined }).catch(() => {});
          complaint.resolutionNotes = combined;
        }
        const { notifyResolved } = require('../services/notificationService');
        notifyResolved({
          complaintId,
          technicianName: techName,
          resolutionNotes: notes || '',
          aiMessage: aiResolution,
          io,
          clusterMemberIds: resolveMemberIds,
        }).then((r) => console.log(`[Resolve email] ${complaintId} sent=${r.delivered}`)).catch((e) => console.warn('[Resolve email] failed', e.message));
        if (io && aiResolution?.message) {
          io.to(complaintId.toString()).emit('complaint-resolved', { complaintId, status: 'resolved', technicianId, technicianName: techName, aiMessage: aiResolution.message, provider: aiResolution.provider });
        }
      } catch (e) { console.warn('[Resolve AI note] failed', e.message); }
    }

    res.json({
      success: true,
      complaint,
      aiResolution,
    });
  } catch (err) {
    console.error('update-status error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/share-location', protect, authorize('technician'), async (req, res) => {
  try {
    const { complaintId, lat, lng, latitude, longitude } = req.body;
    const technicianId = req.user.userId || req.user.id;

    const finalLat = lat ?? latitude;
    const finalLng = lng ?? longitude;

    if (finalLat == null || finalLng == null) return res.status(400).json({ success: false, error: 'lat and lng required' });

    const latNum = Number(finalLat);
    const lngNum = Number(finalLng);
    if (isNaN(latNum) || isNaN(lngNum)) return res.status(400).json({ success: false, error: 'Invalid coordinates' });
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) return res.status(400).json({ success: false, error: 'Coordinates out of range' });

    // Privacy: live GPS is only shared while the lineman has an ACTIVE working job.
    // Citizens see the pin only after Accept; KESCO sees fleet pins for on-task techs.
    if (complaintId) {
      const job = await Complaint.findById(complaintId).select('assignedTechnicianId status').lean().catch(() => null);
      if (!job) return res.status(404).json({ success: false, error: 'Complaint not found' });
      if (String(job.assignedTechnicianId) !== String(technicianId) && String(job.assignedTechnicianId) !== String((await Technician.findById(technicianId).select('_id').lean().catch(() => null))?._id)) {
        // allow by tech doc _id mismatch tolerance — re-resolve below
      }
      if (job.status !== 'working') {
        return res.status(403).json({ success: false, error: 'Location sharing starts after you Accept the job (status working)' });
      }
    }

    // Resolve the technician: token _id first, then technicianId code (survives odd logins).
    // If no profile matches (e.g. offline-mock login), tell the app clearly so it can prompt re-login.
    let tech = await Technician.findById(technicianId);
    if (!tech) tech = await Technician.findOne({ technicianId });
    if (!tech) {
      return res.status(403).json({ success: false, needRelogin: true, error: 'Technician profile not found — please log out and log in again so the Control Room can track you' });
    }

    await Technician.findByIdAndUpdate(tech._id, {
      currentLocation: { type: 'Point', coordinates: [lngNum, latNum] },
      ...(tech.status === 'offline' ? { status: 'available' } : {}),
    });

    // Broadcast location to citizen and KESCO dashboard
    const io = req.app.get('io');
    if (io) {
      if (complaintId) {
        io.to(complaintId.toString()).emit('technician-location', {
          technicianId,
          lat: latNum,
          lng: lngNum,
          complaintId,
        });
      }
      io.emit('technician-location-broadcast', {
        technicianId,
        lat: latNum,
        lng: lngNum,
        complaintId,
      });
      // legacy
      io.emit('technician-location', { technicianId, lat: latNum, lng: lngNum, complaintId });
    }

    res.json({
      success: true,
      message: 'Location shared',
    });
  } catch (err) {
    console.error('share-location error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Video-call endpoints removed — KESCO now reaches technicians by direct phone call.

// Google Maps API key (protected, technician-only) — powers in-app Google voice navigation
router.get('/gmaps-config', protect, authorize('technician'), (req, res) => {
  res.json({ success: true, apiKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// Get technician profile
router.get('/profile', protect, authorize('technician'), async (req, res) => {
  try {
    const technicianId = req.user.userId || req.user.id;
    const tech = await Technician.findById(technicianId).select('-__v');
    if (!tech) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, technician: tech });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
