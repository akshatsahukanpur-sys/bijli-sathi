const express = require('express');
const router = express.Router();
const Complaint = require('../models/Complaint');
const ComplaintCluster = require('../models/ComplaintCluster');
const Technician = require('../models/Technician');
const KESCOAdmin = require('../models/KESCOAdmin');
const { protect, authorize } = require('../middleware/auth');

let overviewCache = { data: null, ts: 0 };

// Attach `mergedCitizenCount` to each duplicate complaint — how many citizens
// reported the SAME merged fault (cluster member count), so the controller sees it.
// Also attaches `mergedCitizens`: the names + meter numbers of every citizen who
// reported the merged fault (revealed when the controller taps the count badge).
async function attachMergedCounts(list) {
  try {
    const withDup = list.filter((c) => c.isDuplicateOf);
    if (!withDup.length) return list;
    const ids = [...new Set(withDup.map((c) => String(c.isDuplicateOf._id || c.isDuplicateOf)))];
    const clusters = await ComplaintCluster.find({ _id: { $in: ids } }).select('_id memberComplaintIds representativeComplaintId').lean();
    const counts = new Map(clusters.map((cl) => [String(cl._id), (cl.memberComplaintIds || []).length]));

    // Fetch the reporting citizens of every merged cluster's member complaints
    const memberIds = [...new Set(clusters.flatMap((cl) => (cl.memberComplaintIds || []).map(String)))];
    const members = memberIds.length
      ? await Complaint.find({ _id: { $in: memberIds } }).select('citizenId createdAt').lean()
      : [];
    const citizenIds = [...new Set(members.map((m) => (m.citizenId ? String(m.citizenId) : '')).filter(Boolean))];
    const users = citizenIds.length
      ? await require('../models/User').find({ _id: { $in: citizenIds } }).select('name meterNumber').lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const clusterCitizens = new Map();
    // Representative's assigned technician per cluster — duplicate rows show ONLY
    // this detail (no assign/picker on duplicates; single dispatch to one lineman)
    const repIds = [...new Set(clusters.map((cl) => String(cl.representativeComplaintId || '')).filter(Boolean))];
    const repDocs = repIds.length
      ? await Complaint.find({ _id: { $in: repIds } })
          .populate('assignedTechnicianId', 'name technicianId phone status')
          .select('assignedTechnicianId status techEtaLabel')
          .lean()
      : [];
    const repDocMap = new Map(repDocs.map((d) => [String(d._id), d]));
    const repTechMap = new Map();
    clusters.forEach((cl) => {
      const rep = repDocMap.get(String(cl.representativeComplaintId || ''));
      if (rep && rep.assignedTechnicianId && typeof rep.assignedTechnicianId === 'object') {
        repTechMap.set(String(cl._id), {
          ...rep.assignedTechnicianId,
          jobStatus: rep.status || 'registered',
          techEtaLabel: rep.techEtaLabel || '',
        });
      }
    });
    clusters.forEach((cl) => {
      const cid = String(cl._id);
      const repId = String(cl.representativeComplaintId || '');
      const cit = (cl.memberComplaintIds || [])
        .map((mc) => {
          const mm = members.find((x) => String(x._id) === String(mc));
          if (!mm || !mm.citizenId) return null;
          const u = userMap.get(String(mm.citizenId));
          return {
            complaintId: String(mc),
            isRepresentative: String(mc) === repId,
            name: u?.name || null,
            meterNumber: u?.meterNumber || null,
          };
        })
        .filter(Boolean);
      clusterCitizens.set(cid, cit);
    });

    list.forEach((c) => {
      if (c.isDuplicateOf) {
        const key = String(c.isDuplicateOf._id || c.isDuplicateOf);
        const count = counts.get(key);
        if (count > 0) c.mergedCitizenCount = count;
        const cit = clusterCitizens.get(key);
        if (cit && cit.length) c.mergedCitizens = cit;
        const rep = repTechMap.get(key);
        if (rep) c.representativeTech = rep;
      }
    });
  } catch (e) { console.warn('attachMergedCounts failed', e.message); }
  return list;
}
// Clear all registered faults — as requested “Delete all the faults which is registered till now from the Tesco dashboard delete from the memory”
router.delete('/clear-registered', protect, authorize('kesco'), async (req, res) => {
  try {
    const del = await Complaint.deleteMany({ status: 'registered' });
    await ComplaintCluster.deleteMany({});
    // Clear overview cache
    overviewCache = { data: null, ts: 0 };
    // Remove references from technicians and users
    await Technician.updateMany({}, { $set: { assignedComplaints: [] } });
    await require('../models/User').updateMany({}, { $set: { complaints: [] } });
    const io = req.app.get('io');
    if (io) io.emit('kesco-clear-registered', { deleted: del.deletedCount });
    res.json({ success: true, deleted: del.deletedCount });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/overview', protect, authorize('kesco'), async (req, res) => {
  try {
    if (overviewCache.data && Date.now() - overviewCache.ts < 5000) {
      return res.json(overviewCache.data);
    }
    // Correct aggregation: facet expects arrays
    const stats = await Complaint.aggregate([
      {
        $facet: {
          active: [{ $match: { status: 'registered' } }, { $count: 'count' }],
          working: [{ $match: { status: 'working' } }, { $count: 'count' }],
          resolved: [{ $match: { status: 'resolved', isDismissed: { $ne: true } } }, { $count: 'count' }],
          dismissed: [{ $match: { isDismissed: true } }, { $count: 'count' }],
          falseFlags: [{ $match: { genuinenessScore: { $lt: 0.4 } } }, { $count: 'count' }],
          duplicates: [{ $match: { isDuplicateOf: { $ne: null } } }, { $count: 'count' }],
          genuineQueue: [{ $match: { genuinenessScore: { $gte: 0.5 }, isDuplicateOf: null, status: { $ne: 'resolved' } } }, { $count: 'count' }],
          photoFlagged: [{ $match: { 'aiPhotoAnalysis.isRelevant': false } }, { $count: 'count' }],
          total: [{ $count: 'count' }],
          avgEta: [{ $match: { etaMinutes: { $exists: true, $ne: null } } }, { $group: { _id: null, avgEta: { $avg: '$etaMinutes' } } }],
          avgResolution: [
            { $match: { status: 'resolved', resolvedAt: { $exists: true } } },
            {
              $group: {
                _id: null,
                avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } },
                count: { $sum: 1 }
              }
            }
          ]
        },
      },
    ]);

    const facet = stats[0] || {};
    const overview = {
      active: facet.active?.[0]?.count || 0,
      working: facet.working?.[0]?.count || 0,
      resolved: facet.resolved?.[0]?.count || 0,
      dismissed: facet.dismissed?.[0]?.count || 0,
      falseFlags: facet.falseFlags?.[0]?.count || 0,
      duplicates: facet.duplicates?.[0]?.count || 0,
      genuineQueue: facet.genuineQueue?.[0]?.count || 0,
      photoFlagged: facet.photoFlagged?.[0]?.count || 0,
      total: facet.total?.[0]?.count || 0,
      avgResolutionMinutes: facet.avgResolution?.[0]?.avgMs ? Math.round(facet.avgResolution[0].avgMs / 60000) : null,
      avgEtaMinutes: facet.avgEta?.[0]?.avgEta ? Math.round(facet.avgEta[0].avgEta) : null,
    };

    // Also get technicians on duty
    const techStats = await Technician.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    const techMap = {};
    techStats.forEach(t => techMap[t._id] = t.count);
    overview.technicians = {
      available: techMap['available'] || 0,
      onTask: techMap['on-task'] || 0,
      offline: techMap['offline'] || 0,
      total: Object.values(techMap).reduce((a,b)=>a+b,0)
    };

    // Recent complaint趋势
    const recent = await Complaint.find().sort({ createdAt: -1 }).limit(5).select('problemVariant status createdAt');

    const payload = { success: true, overview, recent };
    overviewCache = { data: payload, ts: Date.now() };
    res.json(payload);
  } catch (err) {
    console.error('KESCO overview error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/complaints', protect, authorize('kesco'), async (req, res) => {
  try {
    const { status, problemVariant, area, genuineness, isDuplicate, photoFlag, dismissed, sortBy = 'createdAt', order = 'desc', page = 1, limit = 50 } = req.query;
    let filter = {};

    if (status) filter.status = status;
    if (problemVariant) filter.problemVariant = problemVariant;
    if (genuineness === 'false') filter.genuinenessScore = { $lt: 0.4 };
    if (genuineness === 'true') filter.genuinenessScore = { $gte: 0.5 };
    if (isDuplicate === 'true') filter.isDuplicateOf = { $ne: null };
    if (isDuplicate === 'false') filter.isDuplicateOf = null;
    if (photoFlag === 'irrelevant') filter['aiPhotoAnalysis.isRelevant'] = false;
    if (photoFlag === 'verified') filter['aiPhotoAnalysis.isRelevant'] = true;
    if (dismissed === 'true') filter.isDismissed = true;
    if (dismissed === 'false') filter.isDismissed = { $ne: true };
    // area filter: if provided, do geo near? For MVP just text search on description
    if (area) {
      filter.description = { $regex: area, $options: 'i' };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const sortOrder = order === 'asc' ? 1 : -1;

    const complaints = await Complaint.find(filter)
      .populate('citizenId', 'name meterNumber email')
      .populate('assignedTechnicianId', 'name technicianId phone status')
      .populate('recommendedTechnicianId', 'name technicianId phone')
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limitNum)
      .lean();

    await attachMergedCounts(complaints);

    const total = await Complaint.countDocuments(filter);

    res.json({ success: true, complaints, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
  } catch (err) {
    console.error('KESCO complaints error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/clusters', protect, authorize('kesco'), async (req, res) => {
  try {
    const { status = 'active' } = req.query;
    const clusters = await ComplaintCluster.find({
      status,
    })
      .populate('representativeComplaintId', 'problemVariant description location urgencyScore')
      .populate('memberComplaintIds', 'problemVariant description location status citizenId')
      .sort({ reportCount: -1, createdAt: -1 });

    res.json({ success: true, clusters, count: clusters.length });
  } catch (err) {
    console.error('KESCO clusters error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/technicians', protect, authorize('kesco'), async (req, res) => {
  try {
    const { status } = req.query;
    let filter = {};
    if (status) filter.status = status;
    const technicians = await Technician.find(filter).select('name technicianId email phone currentLocation status assignedComplaints createdAt').lean();
    const techIds = technicians.map(t => t._id);
    // Single query for all working assignments (fixes N+1)
    const workingMap = new Map();
    if (techIds.length) {
      const workings = await Complaint.find({ assignedTechnicianId: { $in: techIds }, status: 'working' }).select('ticketId problemVariant location status assignedTechnicianId').lean();
      for (const w of workings) workingMap.set(String(w.assignedTechnicianId), w);
    }
    const withCounts = technicians.map(tech => ({
      ...tech,
      assignedCount: tech.assignedComplaints?.length || 0,
      currentComplaint: tech.status === 'on-task' ? (workingMap.get(String(tech._id)) || null) : null,
    }));
    res.json({ success: true, technicians: withCounts });
  } catch (err) {
    console.error('KESCO technicians error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Area-wise analytics: complaint density by problemVariant and recent heatmap data
router.get('/analytics', protect, authorize('kesco'), async (req, res) => {
  try {
    const byVariant = await Complaint.aggregate([
      { $group: { _id: '$problemVariant', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    const byStatus = await Complaint.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const last7Days = await Complaint.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Heatmap: return all complaint locations for frontend Leaflet heatmap
    const locations = await Complaint.find({ 'location.coordinates': { $exists: true } })
      .select('location problemVariant status urgencyScore')
      .limit(200);

    res.json({ success: true, byVariant, byStatus, last7Days, locations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AI Automation Commander endpoints ───────────────────────────
// Ranked AI shortlist for a complaint: availability → closeness to fault → workload.
// Shown to the KESCO Commander so he can pick who to assign.
router.get('/recommendations/:complaintId', protect, authorize('kesco'), async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.complaintId).select('problemVariant status location assignedTechnicianId recommendedTechnicianId');
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    const recommendations = await require('../services/aiTriage').recommendTechnicians(complaint.location?.coordinates, { limit: 4 });
    res.json({ success: true, complaintId: complaint._id, recommendations });
  } catch (err) {
    console.error('recommendations error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// KESCO Commander: assign nearest available technician — OR a specific one from the AI shortlist
router.post('/assign-nearest', protect, authorize('kesco'), async (req, res) => {
  try {
    const { complaintId, technicianId } = req.body;
    if (!complaintId) return res.status(400).json({ success: false, error: 'complaintId required' });
    const complaint = await Complaint.findById(complaintId);
    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });
    if (complaint.status === 'resolved') return res.status(400).json({ success: false, error: 'Already resolved' });
    if (complaint.isDuplicateOf) return res.status(400).json({ success: false, error: 'Duplicate complaint — dispatching duplicate is blocked; resolve cluster instead' });
    if ((complaint.genuinenessScore ?? 1) < 0.4) return res.status(400).json({ success: false, error: 'Held as possible false complaint — verify in the false queue or unflag before dispatch. No lineman is assigned to unverified reports.' });

    const aiTriage = require('../services/aiTriage');

    // Commander picked a specific technician from the AI shortlist
    let technician = null;
    let distanceKm = null;
    let pickReason = 'nearest available';
    if (technicianId) {
      try { technician = await Technician.findById(technicianId); } catch {}
      if (!technician) technician = await Technician.findOne({ technicianId });
      if (!technician) return res.status(404).json({ success: false, error: 'Selected technician not found' });
      pickReason = 'Commander selected from AI shortlist';
      const tc = technician.currentLocation?.coordinates;
      const fc = complaint.location?.coordinates;
      if (tc && fc && tc.length === 2 && fc.length === 2) {
        distanceKm = Number(aiTriage.haversineKm(fc[1], fc[0], tc[1], tc[0]).toFixed(2));
      }
    } else {
      const nearest = await aiTriage.findNearestTechnician(complaint.location.coordinates);
      technician = nearest.technician;
      distanceKm = nearest.distanceKm;
    }
    if (!technician) return res.status(404).json({ success: false, error: 'No technicians available' });

    // Assign — Commander approved the task; AI ONLY suggests, never auto-dispatches.
    // Status stays 'registered' until the technician explicitly accepts it.
    // No ETA is set here — the technician sets the ETA after accepting.
    const updated = await Complaint.findByIdAndUpdate(
      complaintId,
      { assignedTechnicianId: technician._id, status: 'registered', assignedAt: new Date(), recommendedTechnicianId: null, recommendedDistanceKm: null, recommendedAt: null },
      { new: true }
    ).populate('assignedTechnicianId', 'name technicianId phone');

    // Reserve the job for this technician but keep him 'available' until he hits Accept
    await Technician.findByIdAndUpdate(technician._id, { $addToSet: { assignedComplaints: complaintId } });

    const io = req.app.get('io');
    if (io) {
      io.emit('technician-auto-assigned', { complaintId, technician: { _id: technician._id, name: technician.name }, distanceKm, reason: pickReason });
      io.to(complaintId.toString()).emit('technician-assigned', { complaintId, technicianId: technician._id, distanceKm });
      io.emit('complaint-updated', { complaintId, status: 'registered', assignedTechnicianId: technician._id });
    }
    // Cluster sync — citizens merged into this job's cluster see the same assignment live
    try {
      const ComplaintCluster = require('../models/ComplaintCluster');
      const clusters = await ComplaintCluster.find({ memberComplaintIds: complaintId }).select('memberComplaintIds');
      const memberIds = [...new Set(clusters.flatMap((cl) => (cl.memberComplaintIds || []).map((id) => String(id))))].filter((id) => id !== String(complaintId));
      if (memberIds.length && io) {
        memberIds.forEach((mid) => {
          io.to(mid.toString()).emit('technician-assigned', { complaintId: mid, technicianId: technician._id, distanceKm, sharedFrom: complaintId });
          io.emit('complaint-updated', { complaintId: mid, status: 'registered', sharedFrom: complaintId });
        });
      }
    } catch (e) { console.warn('cluster assign sync failed', e.message); }

    res.json({ success: true, complaint: updated, technician: { _id: technician._id, name: technician.name, technicianId: technician.technicianId }, distanceKm });
  } catch (err) {
    console.error('assign-nearest error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI Queue: all complaints pending AI review / low confidence that need commander attention
router.get('/ai-queue', protect, authorize('kesco'), async (req, res) => {
  try {
    const { type = 'all' } = req.query; // all|fake|duplicate|photo|genuine
    let filter = { status: { $ne: 'resolved' } };
    if (type === 'fake') filter.genuinenessScore = { $lt: 0.4 };
    if (type === 'duplicate') filter.isDuplicateOf = { $ne: null };
    if (type === 'photo') filter['aiPhotoAnalysis.isRelevant'] = false;
    if (type === 'genuine') filter = { genuinenessScore: { $gte: 0.5 }, isDuplicateOf: null, status: { $ne: 'resolved' } };

    const complaints = await Complaint.find(filter)
      .populate('citizenId', 'meterNumber email')
      .populate('assignedTechnicianId', 'name technicianId phone')
      .populate('recommendedTechnicianId', 'name technicianId phone')
      .sort({ genuinenessScore: 1, urgencyScore: -1, createdAt: -1 })
      .limit(50)
      .lean();

    await attachMergedCounts(complaints);

    const counts = await Complaint.aggregate([
      { $facet: {
        fake: [{ $match: { genuinenessScore: { $lt: 0.4 }, status: { $ne: 'resolved' } } }, { $count: 'count' }],
        dup: [{ $match: { isDuplicateOf: { $ne: null }, status: { $ne: 'resolved' } } }, { $count: 'count' }],
        photo: [{ $match: { 'aiPhotoAnalysis.isRelevant': false, status: { $ne: 'resolved' } } }, { $count: 'count' }],
        genuine: [{ $match: { genuinenessScore: { $gte: 0.5 }, isDuplicateOf: null, status: { $ne: 'resolved' } } }, { $count: 'count' }],
      } }
    ]);

    const f = counts[0] || {};
    res.json({
      success: true,
      complaints,
      counts: {
        fake: f.fake?.[0]?.count || 0,
        duplicate: f.dup?.[0]?.count || 0,
        photoFlagged: f.photo?.[0]?.count || 0,
        genuine: f.genuine?.[0]?.count || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/manual-override', protect, authorize('kesco'), async (req, res) => {
  try {
    const { complaintId, action, details } = req.body;

    if (!complaintId || !action) return res.status(400).json({ success: false, error: 'complaintId and action required' });

    let update = {};

    if (action === 'dismiss') {
      const kescoId = req.user.userId || req.user.id;
      update.status = 'resolved';
      update.isDismissed = true;
      update.dismissedAt = new Date();
      update.dismissedBy = kescoId;
      update.resolutionNotes = `Manually dismissed by KESCO: ${details || details?.reason || 'no reason'}`;
      update.resolvedAt = new Date();
      // Free the assigned technician (if any) so he doesn't stay stuck "On-site"
      try {
        const dismissed = await Complaint.findById(complaintId).select('assignedTechnicianId');
        const techId = dismissed?.assignedTechnicianId;
        if (techId) {
          await Technician.findByIdAndUpdate(techId, { $pull: { assignedComplaints: complaintId } });
          const tech = await Technician.findById(techId).select('assignedComplaints');
          const ids = (tech?.assignedComplaints || []).map((c) => (typeof c === 'object' ? c._id : c));
          let active = 0;
          if (ids.length) active = await Complaint.countDocuments({ _id: { $in: ids }, status: 'working' });
          await Technician.findByIdAndUpdate(techId, { status: active > 0 ? 'on-task' : 'available' });
        }
      } catch (e) { console.warn('dismiss: tech release failed', e.message); }
    } else if (action === 'merge') {
      if (!details?.clusterId) return res.status(400).json({ success: false, error: 'clusterId required for merge' });
      update.isDuplicateOf = details.clusterId;
      update.status = 'registered';
      // Also add to cluster
      await ComplaintCluster.findByIdAndUpdate(details.clusterId, {
        $addToSet: { memberComplaintIds: complaintId },
        $inc: { reportCount: 1 }
      });
    } else if (action === 'reassign') {
      if (!details?.newTechnicianId) return res.status(400).json({ success: false, error: 'newTechnicianId required' });
      // Release the previously assigned technician first (else his flag stays
      // on-task forever with no active job and he vanishes from AI picker)
      try {
        const prev = await Complaint.findById(complaintId).select('assignedTechnicianId');
        const oldId = prev?.assignedTechnicianId ? String(prev.assignedTechnicianId) : null;
        if (oldId && oldId !== String(details.newTechnicianId)) {
          await Technician.findByIdAndUpdate(oldId, { $pull: { assignedComplaints: complaintId } });
          const oldTech = await Technician.findById(oldId).select('assignedComplaints').lean().catch(() => null);
          const oldIds = (oldTech?.assignedComplaints || []).map((x) => (typeof x === 'object' ? x._id : x));
          const stillActive = oldIds.length ? await Complaint.countDocuments({ _id: { $in: oldIds }, status: 'working' }) : 0;
          await Technician.findByIdAndUpdate(oldId, { status: stillActive > 0 ? 'on-task' : 'available' });
        }
      } catch (e) { console.warn('reassign: old tech release failed', e.message); }
      update.assignedTechnicianId = details.newTechnicianId;
      update.status = 'working';
      // Update technician records
      await Technician.findByIdAndUpdate(details.newTechnicianId, { $addToSet: { assignedComplaints: complaintId }, status: 'on-task' });
    } else if (action === 'unassign') {
      // Return the complaint to the KESCO pool (unassign the technician) without
      // resolving or dismissing it — next AI suggestion can re-dispatch it.
      const old = await Complaint.findById(complaintId).select('assignedTechnicianId assignedAt status');
      update.assignedTechnicianId = null;
      update.assignedAt = null;
      update.status = 'registered';
      if (old && old.assignedTechnicianId) {
        // Free the previously assigned technician back to Available.
        try {
          const oldTechId = old.assignedTechnicianId;
          await Technician.findByIdAndUpdate(oldTechId, { $pull: { assignedComplaints: complaintId }, status: 'available' });
        } catch (e) { console.warn('unassign: tech release failed', e.message); }
      }
    } else if (action === 'unflag') {
      update.genuinenessScore = 0.8;
      update.isDuplicateOf = null;
      update.isDismissed = false;
      update.dismissedAt = null;
      update.dismissedBy = null;
    } else if (action === 'flag-false') {
      update.genuinenessScore = 0.1;
    } else if (action === 'restore') {
      update.isDismissed = false;
      update.dismissedAt = null;
      update.dismissedBy = null;
      update.status = 'registered';
      update.resolvedAt = null;
      update.resolutionNotes = '';
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action. Use unassign|dismiss|merge|reassign|unflag|flag-false|restore' });
    }

    const complaint = await Complaint.findByIdAndUpdate(
      complaintId,
      update,
      { new: true }
    ).populate('assignedTechnicianId', 'name');

    if (!complaint) return res.status(404).json({ success: false, error: 'Complaint not found' });

    const io = req.app.get('io');
    if (io) {
      io.emit('complaint-updated', {
        complaintId,
        status: complaint.status,
        action,
      });
      io.emit('kesco-override', { complaintId, action, complaint });
    }

    res.json({ success: true, complaint });
  } catch (err) {
    console.error('manual-override error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── KESCO → Technician PHONE CALL (direct dial by phone number) ──
router.post('/call-technician', protect, authorize('kesco'), async (req, res) => {
  try {
    const { technicianId } = req.body;
    if (!technicianId) return res.status(400).json({ success: false, error: 'technicianId required (use technician._id or technicianId string)' });

    // Resolve technician: try by _id first, then by technicianId field
    let technician = null;
    try { technician = await Technician.findById(technicianId); } catch {}
    if (!technician) technician = await Technician.findOne({ technicianId });
    if (!technician) return res.status(404).json({ success: false, error: 'Technician not found' });

    const kescoId = req.user.userId || req.user.id;
    const complaintId = req.body.complaintId || null;
    console.log(`[Phone Call] KESCO ${kescoId} → Tech ${technician.name || technician.technicianId} phone=${technician.phone || 'NOT ON FILE'}${complaintId ? ' complaint=' + complaintId : ''}`);

    if (!technician.phone) {
      return res.status(400).json({ success: false, error: 'Technician has no phone number on file — ask them to add it at login', name: technician.name || technician.technicianId });
    }

    res.json({
      success: true,
      callType: 'phone',
      phone: technician.phone,
      name: technician.name || technician.technicianId,
      message: `Dial ${technician.phone}`,
    });
  } catch (err) {
    console.error('call-technician error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get KESCO profile
router.get('/profile', protect, authorize('kesco'), async (req, res) => {
  try {
    const adminId = req.user.userId || req.user.id;
    const admin = await KESCOAdmin.findById(adminId);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });
    res.json({ success: true, admin });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Citizen complaint history by meter number — used when KESCO clicks MTR in control room
router.get('/citizen-history/:meterNumber', protect, authorize('kesco'), async (req, res) => {
  try {
    const raw = String(req.params.meterNumber || '').trim();
    // Allow "MTR 123" or just "123" — strip prefix
    const meterNumber = raw.replace(/^MTR\s*/i, '').trim();
    if (!meterNumber) return res.status(400).json({ success: false, error: 'meterNumber required' });
    const User = require('../models/User');
    const citizen = await User.findOne({ meterNumber });
    if (!citizen) {
      return res.json({ success: true, complaints: [], citizen: null, message: `No citizen found for meter ${meterNumber}` });
    }
    const complaints = await Complaint.find({ citizenId: citizen._id })
      .populate('citizenId', 'name meterNumber email')
      .populate('assignedTechnicianId', 'name technicianId phone')
      .populate('recommendedTechnicianId', 'name technicianId phone')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({
      success: true,
      complaints,
      citizen: { _id: citizen._id, meterNumber: citizen.meterNumber, name: citizen.name, email: citizen.email },
      count: complaints.length,
    });
  } catch (err) {
    console.error('citizen-history error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Technician history & profile — used when KESCO clicks the technician ID in the control room.
// Accepts technician._id OR the human-readable technicianId string.
router.get('/technician-history/:id', protect, authorize('kesco'), async (req, res) => {
  try {
    const raw = String(req.params.id || '').trim();
    if (!raw) return res.status(400).json({ success: false, error: 'technician id required' });

    let technician = null;
    try { technician = await Technician.findById(raw); } catch (e) { technician = null; }
    if (!technician) technician = await Technician.findOne({ technicianId: raw });
    if (!technician) {
      return res.json({ success: true, technician: null, complaints: [], message: `No technician found for ${raw}` });
    }

    const complaints = await Complaint.find({ assignedTechnicianId: technician._id })
      .populate('citizenId', 'name meterNumber email')
      .populate('assignedTechnicianId', 'name technicianId phone status')
      .populate('recommendedTechnicianId', 'name technicianId phone')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({
      success: true,
      technician: {
        _id: technician._id,
        name: technician.name,
        technicianId: technician.technicianId,
        email: technician.email,
        phone: technician.phone,
        status: technician.status,
        assignedCount: (technician.assignedComplaints || []).length,
        createdAt: technician.createdAt,
      },
      complaints,
      count: complaints.length,
    });
  } catch (err) {
    console.error('technician-history error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
