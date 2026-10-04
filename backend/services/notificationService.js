/**
 * BijliSathi Citizen Notification Service
 * Sends registration confirmation + ETA + AI safety precautions via Email (Brevo) + Socket.IO
 * Called right after AI triage so citizen gets rough resolve time immediately.
 *
 * Reuses Brevo/Resend logic from auth.js
 * @module services/notificationService
 */
const nodemailer = require('nodemailer');
const User = require('../models/User');
const chatAssistant = require('./chatAssistant');

// Verified senders (must match Brevo dashboard)
const VERIFIED_SENDERS = ['akshatsahukanpur@gmail.com'];
function resolveSender(raw) {
  let email = raw || 'akshatsahukanpur@gmail.com';
  let name = 'BijliSathi KESCO';
  const m = String(email).match(/^(.*)<(.*)>\s*$/);
  if (m) { name = (m[1].trim() || name); email = m[2].trim(); }
  else email = String(email).trim();
  const lower = email.toLowerCase();
  if (!VERIFIED_SENDERS.includes(lower) && lower.includes('bijlisathi.com')) email = VERIFIED_SENDERS[0];
  return { email, name };
}
function getTransporter() {
  const isDummy = !process.env.EMAIL_HOST || !process.env.EMAIL_PASSWORD || process.env.EMAIL_PASSWORD === 'your_api_secret' || process.env.EMAIL_PASSWORD === 'xkeysib_placeholder' || process.env.EMAIL_HOST === 'your_host';
  if (isDummy) return null;
  try {
    const port = parseInt(process.env.EMAIL_PORT, 10) || 587;
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
      connectionTimeout: 4000,
      greetingTimeout: 4000,
      socketTimeout: 5000,
    });
  } catch { return null; }
}

// Short public fault ID (FLD-A01 pattern) for citizen-facing text. Never raw _id.
function pubId(c) {
  if (!c) return '';
  if (c.ticketId) return c.ticketId;
  const s = String(c._id || '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  return s ? `FLD-${s}` : '';
}
async function sendEmailViaBrevoOrSmtp({ to, subject, text, html }) {  const { email: fromEmail, name: fromName } = resolveSender(process.env.EMAIL_FROM || 'akshatsahukanpur@gmail.com');
  const isBrevo = String(process.env.EMAIL_PASSWORD || '').startsWith('xkeysib-');
  const transporter = getTransporter();

  // Brevo HTTP first
  if (isBrevo) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.EMAIL_PASSWORD, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: fromName, email: fromEmail },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
        signal: controller.signal,
      });
      clearTimeout(t);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`[Notify] Brevo email to ${to} subject="${subject.slice(0, 50)}"`);
        return { delivered: true, via: 'brevo', id: data.messageId };
      }
      console.warn(`[Notify] Brevo failed ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    } catch (e) {
      console.warn('[Notify] Brevo exception', e.message);
    }
  }
  // Resend HTTP
  const isResend = process.env.EMAIL_USER === 'resend' && String(process.env.EMAIL_PASSWORD || '').startsWith('re_');
  if (isResend) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.EMAIL_PASSWORD}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [to], subject, html, text }),
        signal: controller.signal,
      });
      clearTimeout(t);
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { delivered: true, via: 'resend', id: data.id };
      console.warn(`[Notify] Resend failed ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    } catch (e) {
      console.warn('[Notify] Resend exception', e.message);
    }
  }
  // SMTP fallback
  if (!transporter) {
    console.log(`[Notify DEV] Email to ${to}: ${subject} — Brevo/SMTP not configured, logged only.\n${text.slice(0, 500)}`);
    return { delivered: false, fallback: true };
  }
  try {
    await Promise.race([
      transporter.sendMail({ from: `${fromName} <${fromEmail}>`, to, subject, text, html }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SMTP timeout')), 4000)),
    ]);
    return { delivered: true, via: 'smtp' };
  } catch (e) {
    console.warn(`[Notify] SMTP failed for ${to}: ${e.message}`);
    return { delivered: false, error: e.message };
  }
}

/**
 * Notify citizen after AI triage: registration confirmation + ETA + AI safety
 * precautions via Email (Brevo) + Socket.IO. No OTP, no phone numbers —
 * only the confirmation, the estimated time, and safety precautions.
 * Also emits socket events so both Citizen and KESCO Commander see it live.
 */
async function notifyCitizenETA({ complaint, aiResult, io }) {
  const citizen = await User.findById(complaint.citizenId).select('email meterNumber name').catch(() => null);
  const toEmail = citizen?.email;
  const eta = aiResult.eta; // null when the complaint is flagged false — no fix time exists
  const photo = aiResult.photoAnalysis;
  const assignment = aiResult.assignment;

  const isDup = !!complaint.isDuplicateOf;
  const isFake = complaint.genuinenessScore < 0.4;

  // AI-written safety precautions for this exact fault: vision-AI advice when the
  // photo was analyzed, else the per-variant safety note. Never any phone numbers.
  let safetyPrecautions = '';
  try {
    if (photo?.safetyAdvice) {
      safetyPrecautions = String(photo.safetyAdvice);
    } else {
      const { defaultSafetyNote } = require('./aiTriage');
      safetyPrecautions = defaultSafetyNote(complaint.problemVariant, photo?.severity || 'medium');
    }
  } catch {
    safetyPrecautions = 'Stay away from damaged wires and equipment • never touch anything sparking • keep children away • call 1912 for any emergency';
  }

  // Generate human Sathi-style message (LLM if key, else template)
  let etaMessageObj;
  try {
    etaMessageObj = await chatAssistant.generateEtaMessage({
      complaint,
      eta,
      assignment,
      duplicateInfo: aiResult.duplicateConfidence ? `${Math.round(aiResult.duplicateConfidence * 100)}% duplicate confidence` : null,
      photoAnalysis: photo,
    });
  } catch {
    etaMessageObj = isFake
      ? { message: `Namaste! Your report for ${complaint.problemVariant.replace(/-/g, ' ')} is registered as a FALSE complaint — its text and photo did not match a real electrical fault — and is held for KESCO officer verification. Please do not send false complaints — they waste the electricity department's time and delay repairs for real faults. No fix time can be shown until an officer confirms it. — Sathi`, provider: 'template' }
      : { message: `Rough ETA: ${eta?.label || 'being calculated'}. You’ll be notified as soon as the technician is en route. — Sathi`, provider: 'template' };
  }

  // Build email — registration confirmation + ETA + AI safety precautions.
  // No OTP, no electrician/KESCO phone numbers — safety precautions only.
  const subject = isFake
    ? `BijliSathi: Your report is held for quick KESCO verification — ${complaint.problemVariant.replace(/-/g, ' ')}`
    : isDup
      ? `BijliSathi: Complaint registered — merged with nearby reports • ETA ${eta?.label || ''} — ${complaint.problemVariant.replace(/-/g, ' ')}`
      : `BijliSathi: Complaint registered — rough fix time ${eta?.label || ''} — ${complaint.problemVariant.replace(/-/g, ' ')}${assignment?.assigned ? ' • Lineman assigned' : ''}`;

  const trackUrl = `${(process.env.FRONTEND_URL || 'https://bijli-sathi-lyart.vercel.app').split(',')[0].replace(/\/$/, '')}/#/track/${complaint._id}`;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
    <div style="background:#0A1B33;color:white;padding:20px 22px">
      <div style="font-size:10px;letter-spacing:0.22em;opacity:0.7">BIJLISATHI • KESCO KANPUR • AI TRIAGE</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">${isFake ? 'Your report — held for KESCO verification' : 'Your complaint is registered'}</div>
      <div style="font-size:12px;opacity:0.8;margin-top:4px">Registration confirmed • Estimated fix time • Safety precautions</div>
    </div>
    <div style="padding:22px;background:#fff">
      <p style="margin:0 0 10px">Namaste${citizen?.name ? ` <b>${citizen.name}</b>` : ''},</p>
      <div style="background:#F7F5F0;border:1px solid #E5E7EB;border-radius:12px;padding:14px;margin:12px 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;color:#5A6B8C">SATHI • AI ASSISTANT UPDATE</div>
        <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#0A1B33;white-space:pre-wrap">${etaMessageObj.message.replace(/</g, '&lt;')}</p>
        <div style="font-size:11px;color:#6B7280;margin-top:6px">via ${etaMessageObj.provider} • rough estimate, may vary with load/distance</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0">
        ${!isFake && eta ? `
        <div style="flex:1;min-width:120px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;color:#64748B">ETA</div>
          <div style="font-size:18px;font-weight:800;color:#0A1B33">${eta.label || '~calculating'}</div>
          <div style="font-size:11px;color:#64748B">${eta.estimatedAt ? new Date(eta.estimatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</div>
        </div>` : ''}
        <div style="flex:1;min-width:120px;background:${isFake ? '#FEF2F2' : '#FFFBEB'};border:1px solid ${isFake ? '#FECACA' : '#FDE68A'};border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;color:#92400E">STATUS</div>
          <div style="font-size:14px;font-weight:700;color:#0A1B33;text-transform:capitalize">${complaint.status}${isDup ? ' • merged' : ''}${isFake ? ' • review' : ''}</div>
          <div style="font-size:11px;color:#92400E">${assignment?.assigned ? `Assigned ${assignment.technician?.name || 'lineman'}` : isFake ? 'Held for officer check' : isDup ? 'Merged — one job' : 'Dispatching'}</div>
        </div>
      </div>
      ${safetyPrecautions ? `<div style="margin:12px 0;padding:10px;background:#FFF7ED;border:1px solid #FDBA74;border-radius:10px;font-size:12px;color:#9A3412"><b>⚠️ Safety precautions — protect yourself now:</b> ${String(safetyPrecautions).replace(/</g, '&lt;')}</div>` : ''}
      ${isDup ? `<div style="margin:12px 0;padding:10px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;font-size:12px;color:#92400E"><b>Merged duplicate:</b> Nearby citizens reported the same ${complaint.problemVariant} within ~500m. KESCO is fixing it as one job — no need to re-report. Confidence ${aiResult.duplicateConfidence ? Math.round(aiResult.duplicateConfidence * 100) + '%' : ''}</div>` : ''}
      ${isFake ? `<div style="margin:12px 0;padding:10px;background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;font-size:12px;color:#991B1B"><b>Marked FALSE — held for review:</b> the report text and photo did not match a real electrical fault. A KESCO officer will verify it in the false-complaint queue. Please do not send false complaints — they waste the electricity department's time and delay real repairs.</div>` : ''}
      <div style="text-align:center;margin:18px 0">
        <a href="${trackUrl}" style="display:inline-block;background:#F2A93B;color:#0A1B33;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:999px">Track Live →</a>
        <div style="font-size:11px;color:#64748B;margin-top:6px">Live pulse tracker • technician GPS • Sathi assistant on page</div>
      </div>
      <div style="font-size:12px;color:#475569;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:10px">
        <b>Fault:</b> ${complaint.problemVariant.replace(/-/g, ' ')} — ${complaint.description ? complaint.description.slice(0, 160) : '—'}<br>
        ${complaint.location?.coordinates ? `<a href="https://www.google.com/maps?q=${complaint.location.coordinates[1]},${complaint.location.coordinates[0]}" style="color:#0A1B33">📍 View location</a> • ` : ''}ID ${pubId(complaint)} • ${new Date(complaint.createdAt).toLocaleString('en-IN')}
      </div>
      <p style="margin:16px 0 0;font-size:11px;color:#94A3B8">Sent to ${toEmail || 'citizen'} • KESCO Commander also sees this in his dashboard (duplicate/false queue). Reply via Track chat or this email.</p>
    </div>
    <div style="padding:12px 22px;background:#F7F5F0;font-size:10px;color:#94A3B8;text-align:center">BijliSathi • KESCO Kanpur • AI Commander + Photo Vision • ${new Date().getFullYear()}</div>
  </div>`;

  const text = `BijliSathi — complaint registered (ID ${pubId(complaint)})\n\n${etaMessageObj.message}\n\nETA: ${eta?.label || ''} by ${eta?.estimatedAt ? new Date(eta.estimatedAt).toLocaleString('en-IN') : ''}\nStatus: ${complaint.status}${isDup ? ' (merged duplicate)' : ''}${isFake ? ' — held for review (no fix time until verified)' : ''}\n\nSafety precautions — protect yourself now:\n${safetyPrecautions}\n\nTrack: ${trackUrl}\nComplaint: ${complaint.problemVariant} — ${complaint.description?.slice(0, 120) || ''}`;

  // Send email if we have address (fire-and-forget, don't block triage)
  let emailResult = { delivered: false, skipped: !toEmail };
  if (toEmail) {
    try {
      emailResult = await sendEmailViaBrevoOrSmtp({ to: toEmail, subject, text, html });
    } catch (e) {
      console.warn('[Notify] email error', e.message);
      emailResult = { delivered: false, error: e.message };
    }
  } else {
    console.log(`[Notify] No citizen email for ${complaint._id} — skip email, socket only`);
  }

  // Socket pushes — visible to Citizen (track page) AND KESCO Commander dashboard
  if (io) {
    try {
      const payload = {
        complaintId: complaint._id,
        etaMinutes: complaint.etaMinutes,
        estimatedResolutionAt: complaint.estimatedResolutionAt,
        etaLabel: eta?.label,
        etaMessage: etaMessageObj.message,
        etaProvider: etaMessageObj.provider,
        isDuplicate: isDup,
        duplicateConfidence: aiResult.duplicateConfidence,
        isFake,
        genuinenessScore: complaint.genuinenessScore,
        photoAnalysis: photo,
        assignment,
        citizenEmail: toEmail,
        emailDelivered: !!emailResult.delivered,
      };
      // Citizen targeted
      io.to(complaint._id.toString()).emit('citizen-notified', payload);
      io.to(complaint._id.toString()).emit('eta-estimated', payload);
      // KESCO / global
      io.emit('citizen-notified', payload);
      io.emit('kesco-commander-update', payload);
      if (isDup) io.emit('duplicate-detected', { complaintId: complaint._id, clusterId: complaint.isDuplicateOf, confidence: aiResult.duplicateConfidence, payload });
      if (isFake || photo?.isRelevant === false) io.emit('false-complaint-flagged', { complaintId: complaint._id, genuinenessScore: complaint.genuinenessScore, photoAnalysis: photo, payload });
      console.log(`[Notify] socket citizen-notified ${complaint._id} eta=${eta?.label} dup=${isDup} fake=${isFake} email=${emailResult.delivered ? 'sent' : 'skip/log'}`);
    } catch (e) {
      console.warn('[Notify] socket error', e.message);
    }
  }

  return { delivered: !!emailResult.delivered, via: emailResult.via, etaMessage: etaMessageObj.message, provider: etaMessageObj.provider, subject, citizenEmail: toEmail, eta: eta?.label };
}

module.exports = { notifyCitizenETA, notifyTechEta, notifyResolved, sendEmailViaBrevoOrSmtp };

/**
 * Notify citizen when the assigned lineman ACCEPTS and sets the fix-time ETA.
 * Includes the technician-set ETA + AI safety precautions. Also emailed to
 * every citizen merged in the same duplicate cluster (same response as first reporter).
 */
async function notifyTechEta({ complaintId, etaMinutes, etaLabel, estimatedAt, technician, safetyPrecautions, io, clusterMemberIds = [] }) {
  const Complaint = require('../models/Complaint');
  let complaint = null;
  try {
    complaint = await Complaint.findById(complaintId).lean();
    if (!complaint) return { delivered: false, error: 'not-found' };
  } catch (e) { return { delivered: false, error: e.message }; }

  const techName = technician?.name || technician?.technicianId || 'KESCO lineman';
  let msgObj;
  try {
    msgObj = await chatAssistant.generateTechEtaMessage({
      complaint, etaMinutes, etaLabel, estimatedAt, technicianName: techName, safetyPrecautions,
    });
  } catch {
    msgObj = { message: `Namaste! Your lineman ${techName} accepted your ${String(complaint.problemVariant).replace(/-/g, ' ')} complaint. Estimated resolution: ${etaLabel}. Live tracking is now active. — Sathi`, provider: 'template' };
  }

  const targets = [String(complaintId), ...clusterMemberIds.map(String)];
  const trackUrl = (id) => `${(process.env.FRONTEND_URL || 'https://bijli-sathi-lyart.vercel.app').split(',')[0].replace(/\/$/, '')}/#/track/${id}`;
  const faultLabel = String(complaint.problemVariant || '').replace(/-/g, ' ');
  const subject = `BijliSathi: Lineman ${techName} on the way — fix in ${etaLabel} — ${faultLabel}`;
  const firstSafety = String(safetyPrecautions || '').split('\n').filter(Boolean)[0] || '';

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
    <div style="background:#0A1B33;color:white;padding:20px 22px">
      <div style="font-size:10px;letter-spacing:0.22em;opacity:0.7">BIJLISATHI • KESCO KANPUR</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Lineman on the way — ${etaLabel}</div>
      <div style="font-size:12px;opacity:0.8;margin-top:4px">${techName} • live GPS active</div>
    </div>
    <div style="padding:22px;background:#fff">
      <p style="margin:0 0 10px;font-size:14px;line-height:1.6;white-space:pre-wrap">${msgObj.message.replace(/</g, '&lt;')}</p>
      ${firstSafety ? `<div style="margin:12px 0;padding:10px;background:#FFF7ED;border:1px solid #FDBA74;border-radius:10px;font-size:12px;color:#9A3412"><b>Safety:</b> ${firstSafety.replace(/</g, '&lt;')}</div>` : ''}
      <div style="text-align:center;margin:16px 0"><a href="${trackUrl(complaintId)}" style="display:inline-block;background:#F2A93B;color:#0A1B33;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:999px">Track Live →</a></div>
      <div style="font-size:11px;color:#94A3B8">Complaint ${pubId(complaint)} • ${faultLabel}</div>
    </div>
  </div>`;
  const text = `${msgObj.message}\n\nTrack: ${trackUrl(complaintId)}\nSafety: ${firstSafety}`;

  // Email the primary citizen + every merged duplicate member (same response for all)
  const emailedTo = [];
  const idsToMail = [complaint.citizenId, ...(await resolveClusterCitizens(clusterMemberIds))];
  const uniqueEmails = [...new Set(idsToMail.filter(Boolean))];
  // Resolve citizen emails
  try {
    const users = await User.find({ _id: { $in: uniqueEmails } }).select('email').lean().catch(() => []);
    // Also include direct email strings if any
    for (const u of users) {
      if (!u?.email) continue;
      try {
        const r = await sendEmailViaBrevoOrSmtp({ to: u.email, subject, text, html });
        if (r?.delivered) emailedTo.push(u.email);
      } catch {}
    }
  } catch (e) { console.warn('[Notify ETA] email fan-out failed', e.message); }

  if (io) {
    try {
      const payload = { complaintId, etaMinutes, etaLabel, estimatedResolutionAt: estimatedAt, technicianId: technician?._id || technician, technicianName: techName, safetyPrecautions, message: msgObj.message, provider: msgObj.provider };
      targets.forEach((id) => { io.to(id.toString()).emit('eta-estimated', { ...payload, complaintId: id }); io.to(id.toString()).emit('technician-assigned', { ...payload, complaintId: id }); });
      io.emit('complaint-updated', { complaintId, status: 'working', etaMinutes, etaLabel });
    } catch {}
  }
  return { delivered: emailedTo.length > 0, emailedTo, message: msgObj.message, provider: msgObj.provider };
}

async function resolveClusterCitizens(clusterMemberIds) {
  if (!clusterMemberIds?.length) return [];
  try {
    const Complaint = require('../models/Complaint');
    const members = await Complaint.find({ _id: { $in: clusterMemberIds } }).select('citizenId').lean();
    return members.map((m) => String(m.citizenId)).filter(Boolean);
  } catch { return []; }
}

/**
 * AI resolution note — emailed when the lineman marks the job resolved.
 * Wording is AI-generated. Sent to primary + all merged duplicate citizens.
 */
async function notifyResolved({ complaintId, technicianName, resolutionNotes, aiMessage, io, clusterMemberIds = [] }) {
  const Complaint = require('../models/Complaint');
  let complaint = null;
  try {
    complaint = await Complaint.findById(complaintId).lean();
    if (!complaint) return { delivered: false, error: 'not-found' };
  } catch (e) { return { delivered: false, error: e.message }; }

  let msgObj = aiMessage;
  if (!msgObj) {
    try {
      msgObj = await chatAssistant.generateResolutionMessage({ complaint, technicianName, resolutionNotes });
    } catch {
      msgObj = { message: `Namaste! Your ${String(complaint.problemVariant).replace(/-/g, ' ')} complaint is resolved by ${technicianName}. Please confirm on Track or reopen if still faulty. — Sathi`, provider: 'template' };
    }
  }

  const faultLabel = String(complaint.problemVariant || '').replace(/-/g, ' ');
  const subject = `BijliSathi: Resolved — ${faultLabel} fixed — please confirm`;
  const trackUrl = (id) => `${(process.env.FRONTEND_URL || 'https://bijli-sathi-lyart.vercel.app').split(',')[0].replace(/\/$/, '')}/#/track/${id}`;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
    <div style="background:#0A2E1F;color:white;padding:20px 22px">
      <div style="font-size:10px;letter-spacing:0.22em;opacity:0.7">BIJLISATHI • KESCO KANPUR</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Power restored — please confirm</div>
      <div style="font-size:12px;opacity:0.8;margin-top:4px">Fixed by ${String(technicianName).replace(/</g, '&lt;')}</div>
    </div>
    <div style="padding:22px;background:#fff">
      <p style="margin:0 0 10px;font-size:14px;line-height:1.6;white-space:pre-wrap">${msgObj.message.replace(/</g, '&lt;')}</p>
      <div style="text-align:center;margin:16px 0"><a href="${trackUrl(complaintId)}" style="display:inline-block;background:#2E9E6B;color:white;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:999px">Confirm / Reopen →</a></div>
      <div style="font-size:11px;color:#94A3B8">Complaint ${pubId(complaint)} • ${faultLabel}</div>
    </div>
  </div>`;
  const text = `${msgObj.message}\n\nConfirm: ${trackUrl(complaintId)}`;

  const emailedTo = [];
  try {
    const memberCitizens = await resolveClusterCitizens(clusterMemberIds);
    const allCitizenIds = [...new Set([String(complaint.citizenId), ...memberCitizens])].filter(Boolean);
    const users = await User.find({ _id: { $in: allCitizenIds } }).select('email').lean().catch(() => []);
    for (const u of users) {
      if (!u?.email) continue;
      try {
        const r = await sendEmailViaBrevoOrSmtp({ to: u.email, subject, text, html });
        if (r?.delivered) emailedTo.push(u.email);
      } catch {}
    }
  } catch (e) { console.warn('[Notify Resolved] email fan-out failed', e.message); }

  if (io) {
    try {
      const targets = [String(complaintId), ...clusterMemberIds.map(String)];
      targets.forEach((id) => {
        io.to(id.toString()).emit('complaint-resolved', { complaintId: id, status: 'resolved', technicianName, resolutionNotes, aiMessage: msgObj.message, provider: msgObj.provider, sharedFrom: id === String(complaintId) ? undefined : complaintId });
        io.emit('complaint-status-updated', { complaintId: id, status: 'resolved' });
      });
    } catch {}
  }
  return { delivered: emailedTo.length > 0, emailedTo, message: msgObj.message, provider: msgObj.provider };
}
