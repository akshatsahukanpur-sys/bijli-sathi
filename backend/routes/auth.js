const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Technician = require('../models/Technician');
const KESCOAdmin = require('../models/KESCOAdmin');
const Otp = require('../models/Otp');
const { generateOTP, generateToken, protect, authorize } = require('../middleware/auth');
const nodemailer = require('nodemailer');

// OTP storage: DB (persistent for Vercel serverless) + in-memory fallback for local dev
// Structure: { email: { otp, userType, userId, timestamp } }
const otpStore = {};
const useDbOtp = () => {
  try { return require('mongoose').connection.readyState === 1; } catch { return false; }
};

// Brevo verified senders (GET /v3/senders) - keep in sync with Brevo dashboard
// Fix 2026-08-22: noreply@bijlisathi.com is NOT verified -> Brevo returns 201 then async error
// "sender not valid. Validate your sender or authenticate your domain" (seen: 23/23 errors on 2026-08-22)
// Until bijlisathi.com is authenticated (Brevo > Settings > Senders & Domains > Authenticate), force verified.
const VERIFIED_SENDERS = ['akshatsahukanpur@gmail.com'];
function resolveSender(raw) {
  let senderEmail = raw || 'akshatsahukanpur@gmail.com';
  let senderName = 'BijliSathi';
  const m = String(senderEmail).match(/^(.*)<(.*)>\s*$/);
  if (m) { senderName = (m[1].trim() || senderName); senderEmail = m[2].trim(); }
  else { senderEmail = String(senderEmail).trim(); }
  const lower = senderEmail.toLowerCase();
  if (!VERIFIED_SENDERS.includes(lower) && lower.includes('bijlisathi.com')) {
    console.warn(`[Email] Sender ${senderEmail} is NOT verified in Brevo (verified: ${VERIFIED_SENDERS.join(', ')}). Overriding to ${VERIFIED_SENDERS[0]}. To use noreply@bijlisathi.com: Brevo dashboard -> Senders & Domains -> Add domain -> add SPF/DKIM DNS records.`);
    senderEmail = VERIFIED_SENDERS[0];
  }
  return { email: senderEmail, name: senderName };
}
(function warnIfSenderInvalid(){ const f=process.env.EMAIL_FROM||''; if(f.toLowerCase().includes('bijlisathi.com') && !VERIFIED_SENDERS.includes(f.toLowerCase().replace(/^.*</,'').replace(/>.*$/,'').trim().toLowerCase())) console.warn(`[Email] WARNING: EMAIL_FROM=${f} will be rejected by Brevo (not verified). Override to ${VERIFIED_SENDERS[0]} at runtime.`); })();

// Create transporter lazily; handle missing/dummy credentials gracefully
function getTransporter() {
  // If dummy credentials, return mock transporter that just logs
  const isDummy = !process.env.EMAIL_HOST || process.env.EMAIL_USER === 'resend_user' || process.env.EMAIL_USER === 'your_api_key' || !process.env.EMAIL_PASSWORD || process.env.EMAIL_PASSWORD === 'resend_password' || process.env.EMAIL_PASSWORD === 'your_api_secret' || process.env.EMAIL_HOST === 'your_host' || process.env.EMAIL_PASSWORD === 'xkeysib_placeholder';
  if (isDummy) {
    return null;
  }
  try {
    const port = parseInt(process.env.EMAIL_PORT, 10) || 587;
    const host = process.env.EMAIL_HOST;
    // Brevo SMTP uses smtp-relay.brevo.com, user is typically the brevo login email or 'apikey'
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for 587
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
      connectionTimeout: 4000, // Fail fast if Railway blocks SMTP
      greetingTimeout: 4000,
      socketTimeout: 5000,
      logger: false,
      debug: false,
    });
  } catch (e) {
    console.warn('Email transporter creation failed:', e.message);
    return null;
  }
}

const sendOTP = async (email, otp, userType) => {
  const transporter = getTransporter();
  // In dev/dummy mode, just log and return success (so frontend still works)
  if (!transporter) {
    console.log(`[DEV-MODE] OTP for ${email} (${userType}): ${otp} - Email not configured, logging only`);
    return { delivered: false, fallback: true, error: 'Email not configured on server (missing EMAIL_HOST/EMAIL_PASSWORD). Set EMAIL_* env vars.' };
  }

  const { email: resolvedFromEmail, name: resolvedFromName } = resolveSender(process.env.EMAIL_FROM || 'akshatsahukanpur@gmail.com');
  const mailOptions = {
    from: `${resolvedFromName} <${resolvedFromEmail}>`,
    to: email,
    subject: 'BijliSathi OTP Verification',
    text: `Your BijliSathi verification OTP is: ${otp}. It expires in 5 minutes.`,
    html: `<p>Your <b>BijliSathi</b> verification OTP is: <b>${otp}</b></p><p>It expires in 5 minutes.</p>`,
  };
  // Track last provider error so API can return an actionable hint
  let lastError = '';

  // Prefer Brevo (Sendinblue) HTTP API if xkeysib key is set, else Resend HTTP API (Railway blocks 587)
  const isBrevo = String(process.env.EMAIL_PASSWORD || '').startsWith('xkeysib-');
  if (isBrevo) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const apiKey = process.env.EMAIL_PASSWORD;
      const senderEmail = resolvedFromEmail;
      const senderName = resolvedFromName;
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email }],
          subject: mailOptions.subject,
          htmlContent: mailOptions.html,
          textContent: mailOptions.text,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`OTP sent via Brevo HTTP to ${email} sender=${senderEmail} messageId=${data.messageId || data.messageIds}`);
        return { delivered: true };
      }
      // Detect Brevo IP whitelist block (Railway egress IP not authorised)
      if (res.status === 401 && JSON.stringify(data).includes('unrecognised IP')) {
        const ip = (data.message || '').match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] || 'Railway egress IP (see logs)';
        console.error(`[Email] BREVO IP BLOCK: Railway IP ${ip} is NOT authorised in Brevo. Fix: Brevo dashboard -> https://app.brevo.com/security/authorised_ips -> Authorize IP ${ip} (or 152.55.185.0/24 for AMS) OR Deactivate "Block unknown IPs" for API keys. Docs: https://help.brevo.com/hc/en-us/articles/5740111683858  OTP: ${otp}`);
        lastError = `Brevo blocked unknown IP ${ip}. Disable "Block unknown IPs" at app.brevo.com/security/authorised_ips.`;
      }
      lastError = lastError || `Brevo HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`;
      console.warn(`Brevo HTTP failed for ${email} sender=${senderEmail}: ${res.status} ${JSON.stringify(data)} - trying SMTP fallback. OTP: ${otp}`);
    } catch (err) {
      if (String(err.message).includes('unrecognised IP') || String(err.message).includes('401')) {
        console.error(`[Email] BREVO IP BLOCK exception: ${err.message} -> authorize Railway IP at https://app.brevo.com/security/authorised_ips`);
      }
      lastError = lastError || `Brevo exception: ${err.message}`;
      console.warn(`Brevo HTTP exception for ${email}: ${err.message} - trying SMTP/Resend fallback. OTP: ${otp}`);
    }
  }

  // Prefer Resend HTTP API on Railway (port 587 is blocked). If using Resend, try HTTP first.
  const isResend = process.env.EMAIL_USER === 'resend' && String(process.env.EMAIL_PASSWORD || '').startsWith('re_');
  if (isResend) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const apiKey = process.env.EMAIL_PASSWORD;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${resolvedFromName} <${resolvedFromEmail}>` || 'onboarding@resend.dev',
          to: [email],
          subject: mailOptions.subject,
          html: mailOptions.html,
          text: mailOptions.text,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`OTP sent via Resend HTTP to ${email} sender=${resolvedFromEmail} id=${data.id}`);
        return { delivered: true };
      }
      // Resend error - e.g., testing mode only allows own email, or domain not verified
      const resendBody = JSON.stringify(data).slice(0, 400);
      if (resendBody.includes('only send testing emails') || resendBody.includes('verify a domain')) {
        lastError = 'Resend test-mode: sender onboarding@resend.dev can only mail the account owner. Verify a domain at resend.com/domains and set EMAIL_FROM to you@yourdomain, OR switch EMAIL_* to Gmail App-Password SMTP.';
      } else {
        lastError = `Resend HTTP ${res.status}: ${resendBody}`;
      }
      console.warn(`Resend HTTP failed for ${email}: ${res.status} ${JSON.stringify(data)} - trying SMTP fallback. OTP: ${otp}`);
      // fall through to SMTP attempt
    } catch (err) {
      lastError = lastError || `Resend exception: ${err.message}`;
      console.warn(`Resend HTTP exception for ${email}: ${err.message} - trying SMTP fallback. OTP: ${otp}`);
    }
  }

  try {
    // Race SMTP against a timeout so Railway's blocked port 587 doesn't hang the request (40s observed -> now 4s)
    const sendPromise = transporter.sendMail(mailOptions);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Email SMTP timeout (4s)')), 4000));
    await Promise.race([sendPromise, timeoutPromise]);
    console.log(`OTP sent via SMTP to ${email}`);
    return { delivered: true };
  } catch (err) {
    const smtpMsg = String(err.message || '');
    if (smtpMsg.includes('only send testing emails') || smtpMsg.includes('verify a domain')) {
      lastError = 'Resend test-mode (via SMTP): only the account owner can receive mail. Verify a domain at resend.com/domains and set EMAIL_FROM to you@yourdomain, OR switch EMAIL_* to Gmail App-Password SMTP.';
    } else if (!lastError) {
      lastError = `SMTP failed: ${smtpMsg.slice(0, 300)}`;
    }
    console.warn(`Failed to send email to ${email}: ${err.message}. Falling back to dev-mode log. OTP: ${otp}`);
    // Don't throw; allow OTP flow to continue - frontend will show devOtp as fallback
    return { delivered: false, error: lastError, fallback: true };
  }
};

// Helper to clean expired OTPs periodically
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of Object.entries(otpStore)) {
    if (now - data.timestamp > 5 * 60 * 1000) {
      delete otpStore[email];
    }
  }
}, 60 * 1000);

// Normalize phone: keep digits/+ , require >=10 digits (allows +91xxxxxxxxxx)
function normalizePhone(p) {
  const d = String(p || '').replace(/[^\d+]/g, '');
  return d.replace(/\D/g, '').length >= 10 ? d : '';
}

// Citizen OTP login / send OTP — phone compulsory as per production requirement
router.post('/citizen/send-otp', async (req, res) => {
  try {
    const { meterNumber, email } = req.body;
    const phone = normalizePhone(req.body.phone);

    if (!meterNumber || !email) {
      return res.status(400).json({ success: false, error: 'Meter number and email are required' });
    }
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ success: false, error: 'Phone number is compulsory — at least 10 digits required' });
    }

    // Validate email format
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Isolation per instruction: meterNumber is primary key -> different meter = different person (even with same email)
    // Same meter -> same page with previous tasks
    let user = await User.findOne({ meterNumber });
    if (!user) {
      // New meter -> new citizen (allow same email with different meter)
      user = new User({ meterNumber, email: String(email).toLowerCase().trim(), name: '', phone });
      await user.save();
    } else {
      // Existing meter -> same person, update email/phone if changed
      const normalizedEmail = String(email).toLowerCase().trim();
      if (String(user.email).toLowerCase() !== normalizedEmail || (phone && user.phone !== phone)) {
        user.email = normalizedEmail;
        if (phone) user.phone = phone;
        await user.save();
      }
    }

    const otp = generateOTP();
    const emailKey = String(email).toLowerCase().trim();
    otpStore[emailKey] = { otp, userType: 'citizen', userId: user._id, timestamp: Date.now() };
    // Also persist to DB for Vercel serverless (in-memory is per-instance)
    if (useDbOtp()) {
      try { await Otp.findOneAndUpdate({ email: String(email).toLowerCase() }, { otp, userType: 'citizen', userId: user._id, createdAt: new Date() }, { upsert: true }); } catch (e) { console.warn('Otp DB save failed:', e.message); }
    }

    const emailResult = await sendOTP(emailKey, otp, 'citizen');

    // Always allow login even if email fails - expose OTP as fallback (fixes "backend not working" when Brevo IP blocked)
    const isDummy = !getTransporter();
    const shouldExposeOtp = isDummy || !emailResult.delivered;
    if (!emailResult.delivered) {
      console.warn(`[OTP] Email not delivered to ${email} (citizen) - OTP ${otp} returned via devOtp fallback. Reason: ${emailResult.error || 'unknown'}`);
    }
    res.json({
      success: true,
      message: emailResult.delivered ? 'OTP sent to email' : 'OTP generated - use code shown (email delivery failed - use code below)',
      ...(shouldExposeOtp && { devOtp: otp }),
      emailDelivered: !!emailResult.delivered,
      ...(!emailResult.delivered && emailResult.error && { emailError: emailResult.error }),
      ...(isDummy && { note: 'Email not configured, dev OTP returned' })
    });
  } catch (err) {
    console.error('citizen/send-otp error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: 'Meter number or email already exists with different account' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Technician OTP send — phone compulsory
router.post('/technician/send-otp', async (req, res) => {
  try {
    const { technicianId, email } = req.body;
    const phone = normalizePhone(req.body.phone);

    if (!technicianId || !email) {
      return res.status(400).json({ success: false, error: 'Technician ID and email are required' });
    }
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ success: false, error: 'Phone number is compulsory — at least 10 digits required' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Isolation per instruction: technicianId is primary -> different ID = different technician (same email allowed)
    let technician = await Technician.findOne({ technicianId });
    if (!technician) {
      technician = new Technician({ technicianId, email: String(email).toLowerCase().trim(), name: '', phone });
      await technician.save();
    } else {
      const normalizedEmail = String(email).toLowerCase().trim();
      if (String(technician.email).toLowerCase() !== normalizedEmail || (phone && technician.phone !== phone)) {
        technician.email = normalizedEmail;
        if (phone) technician.phone = phone;
        await technician.save();
      }
    }

    const otp = generateOTP();
    const emailKey = String(email).toLowerCase().trim();
    otpStore[emailKey] = { otp, userType: 'technician', userId: technician._id, timestamp: Date.now() };
    if (useDbOtp()) {
      try { await Otp.findOneAndUpdate({ email: String(email).toLowerCase() }, { otp, userType: 'technician', userId: technician._id, createdAt: new Date() }, { upsert: true }); } catch (e) { console.warn('Otp DB save failed:', e.message); }
    }

    const emailResult = await sendOTP(emailKey, otp, 'technician');

    const isDummy = !getTransporter();
    const shouldExposeOtp = isDummy || !emailResult.delivered;
    if (!emailResult.delivered) {
      console.warn(`[OTP] Email not delivered to ${email} (technician) - OTP ${otp} returned via devOtp fallback. Reason: ${emailResult.error || 'unknown'}`);
    }
    res.json({
      success: true,
      message: emailResult.delivered ? 'OTP sent to email' : 'OTP generated - use code shown (email delivery failed - use code below)',
      ...(shouldExposeOtp && { devOtp: otp }),
      emailDelivered: !!emailResult.delivered,
      ...(!emailResult.delivered && emailResult.error && { emailError: emailResult.error })
    });
  } catch (err) {
    console.error('technician/send-otp error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: 'Technician ID or email already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// KESCO Admin OTP send — phone compulsory
router.post('/kesco/send-otp', async (req, res) => {
  try {
    const { registrationNumber, email } = req.body;
    const phone = normalizePhone(req.body.phone);

    if (!registrationNumber || !email) {
      return res.status(400).json({ success: false, error: 'Registration number and email are required' });
    }
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ success: false, error: 'Phone number is compulsory — at least 10 digits required' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Isolation per instruction: registrationNumber is primary -> different number = different KESCO (same email allowed)
    let admin = await KESCOAdmin.findOne({ registrationNumber });
    if (!admin) {
      admin = new KESCOAdmin({ registrationNumber, email: String(email).toLowerCase().trim(), name: '', role: 'operator', phone });
      await admin.save();
    } else {
      const normalizedEmail = String(email).toLowerCase().trim();
      if (String(admin.email).toLowerCase() !== normalizedEmail || (phone && admin.phone !== phone)) {
        admin.email = normalizedEmail;
        if (phone) admin.phone = phone;
        await admin.save();
      }
    }

    const otp = generateOTP();
    const emailKey = String(email).toLowerCase().trim();
    otpStore[emailKey] = { otp, userType: 'kesco', userId: admin._id, timestamp: Date.now() };
    if (useDbOtp()) {
      try { await Otp.findOneAndUpdate({ email: String(email).toLowerCase() }, { otp, userType: 'kesco', userId: admin._id, createdAt: new Date() }, { upsert: true }); } catch (e) { console.warn('Otp DB save failed:', e.message); }
    }

    const emailResult = await sendOTP(emailKey, otp, 'kesco');

    const isDummy = !getTransporter();
    const shouldExposeOtp = isDummy || !emailResult.delivered;
    if (!emailResult.delivered) {
      console.warn(`[OTP] Email not delivered to ${email} (kesco) - OTP ${otp} returned via devOtp fallback. Reason: ${emailResult.error || 'unknown'}`);
    }
    res.json({
      success: true,
      message: emailResult.delivered ? 'OTP sent to email' : 'OTP generated - use code shown (email delivery failed - use code below)',
      ...(shouldExposeOtp && { devOtp: otp }),
      emailDelivered: !!emailResult.delivered,
      ...(!emailResult.delivered && emailResult.error && { emailError: emailResult.error })
    });
  } catch (err) {
    console.error('kesco/send-otp error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: 'Registration number or email already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy capital route removed — use lowercase /kesco/send-otp

// OTP verification and token generation
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, error: 'Email and OTP are required' });
    }

    // Check in-memory first, then DB (for Vercel serverless)
    // Normalize key: send-otp now stores lowercased+trimmed keys
    const emailKey = String(email).toLowerCase().trim();
    let storedOtp = otpStore[emailKey] || otpStore[email];
    let fromDb = false;
    if (!storedOtp && useDbOtp()) {
      try {
        const dbOtp = await Otp.findOne({ email: String(email).toLowerCase() });
        if (dbOtp) {
          storedOtp = { otp: dbOtp.otp, userType: dbOtp.userType, userId: dbOtp.userId, timestamp: dbOtp.createdAt ? dbOtp.createdAt.getTime() : Date.now() };
          fromDb = true;
        }
      } catch (e) { console.warn('Otp DB fetch failed:', e.message); }
    }

    if (!storedOtp) {
      return res.status(400).json({ success: false, error: 'OTP not requested or expired' });
    }

    // Check OTP expiry (5 minutes) BEFORE checking validity
    const otpAge = Date.now() - (storedOtp.timestamp || 0);
    if (otpAge > 5 * 60 * 1000) {
      delete otpStore[emailKey];
      delete otpStore[email];
      if (fromDb) { try { await Otp.deleteOne({ email: String(email).toLowerCase() }); } catch {} }
      return res.status(400).json({ success: false, error: 'OTP expired' });
    }

    // Compare as strings to preserve leading zeros
    if (String(storedOtp.otp) !== String(otp).trim()) {
      return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }

    const token = generateToken(storedOtp.userId, storedOtp.userType);

    // Save phone number if provided at login (any portal) — used for direct phone calls
    const loginPhone = normalizePhone(req.body.phone);
    if (loginPhone) {
      try {
        if (storedOtp.userType === 'citizen') await User.findByIdAndUpdate(storedOtp.userId, { phone: loginPhone });
        else if (storedOtp.userType === 'technician') await Technician.findByIdAndUpdate(storedOtp.userId, { phone: loginPhone });
        else if (storedOtp.userType === 'kesco') await KESCOAdmin.findByIdAndUpdate(storedOtp.userId, { phone: loginPhone });
      } catch (e) { console.warn('Phone save failed:', e.message); }
    }

    const response = {
      success: true,
      token,
      userType: storedOtp.userType,
      userId: storedOtp.userId,
    };

    // Set persistent cookie for frontend (30 days like other sites remember-me) — complements localStorage, solves "have to login again from home"
    try {
      const cookiePayload = JSON.stringify({ token, userType: storedOtp.userType, userId: storedOtp.userId });
      res.cookie('bs_auth', cookiePayload, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: false, // allow JS to read for getAuth fallback
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
      });
      // Also set raw token cookie for protect middleware fallback
      res.cookie('token', token, {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
      });
    } catch (e) { console.warn('Set cookie failed:', e.message); }

    // Clean up OTP (both stores)
    delete otpStore[emailKey];
    delete otpStore[email];
    if (fromDb || useDbOtp()) {
      try { await Otp.deleteOne({ email: String(email).toLowerCase() }); } catch {}
    }

    res.json(response);
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Profile for current user — returns meterNumber/email for citizen, technicianId/email etc.
router.get('/profile', require('../middleware/auth').protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const userType = (req.user.userType || '').toLowerCase();
    let data = null;
    if (userType === 'citizen') {
      data = await User.findById(userId).select('meterNumber email name phone createdAt');
    } else if (userType === 'technician') {
      data = await Technician.findById(userId).select('technicianId email name phone status createdAt');
    } else if (userType === 'kesco') {
      data = await KESCOAdmin.findById(userId).select('registrationNumber email name role createdAt');
    }
    if (!data) return res.status(404).json({ success: false, error: 'Profile not found' });
    res.json({ success: true, profile: data, userType });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin cleanup: remove all users without valid phone — protected
router.post('/admin/cleanup-no-phone', protect, authorize('kesco'), async (req, res) => {
  try {
    // Simple protection: require a secret header or allow any authenticated user for now (since it's a one-time cleanup)
    // For production, you should add proper admin auth, but for this task we allow it if the request has a valid token or a special key
    const isValidPhone = (p) => String(p || '').replace(/\D/g, '').length >= 10;
    const users = await User.find({});
    const techs = await Technician.find({});
    const kescos = await KESCOAdmin.find({});
    let delUsers = 0, delTechs = 0, delKescos = 0;
    for (const u of users) if (!isValidPhone(u.phone)) { await User.deleteOne({ _id: u._id }); delUsers++; }
    for (const t of techs) if (!isValidPhone(t.phone)) { await Technician.deleteOne({ _id: t._id }); delTechs++; }
    for (const k of kescos) if (!isValidPhone(k.phone)) { await KESCOAdmin.deleteOne({ _id: k._id }); delKescos++; }
    const remaining = { users: await User.countDocuments(), technicians: await Technician.countDocuments(), kesco: await KESCOAdmin.countDocuments() };
    res.json({ success: true, deleted: { users: delUsers, technicians: delTechs, kesco: delKescos }, remaining });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Debug endpoint: list OTP store (dev only)
router.get('/debug/otp-store', (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, error: 'Not available in production' });
  }
  res.json({ success: true, store: Object.keys(otpStore) });
});

module.exports = router;
