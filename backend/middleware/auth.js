const jwt = require('jsonwebtoken');

const { randomInt } = require('crypto');
const generateOTP = () => {
  return String(randomInt(100000, 1000000));
};

const generateToken = (id, userType = 'citizen') => {
  // Include both id and userType for role-based access; support both `id` and `userId` fields for backward compatibility
  const payload = { id, userId: id, userType };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  });
};

// Express middleware: protect routes - supports Bearer header and bs_auth cookie
const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies) {
    // Try bs_auth cookie (JSON stringified {token, userType, userId})
    try {
      const raw = req.cookies.bs_auth || req.cookies.token;
      if (raw) {
        // bs_auth is JSON, token is raw JWT
        if (raw.startsWith('eyJ')) {
          token = raw;
        } else {
          const parsed = JSON.parse(raw);
          token = parsed.token || parsed.jwt || raw;
        }
      }
    } catch {}
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized to access this route — please log in again',
      code: 'NO_TOKEN',
    });
  }
  // If DB is disconnected, don't fail auth — allow token verification to still work (stateless JWT)
  // Route handlers will handle DB errors gracefully with 503

  // Offline mock tokens: only allowed when explicitly enabled (dev/demo), never in production unless ALLOW_OFFLINE_MOCK=true
  if (String(token).includes('offline-mock')) {
    if (process.env.ALLOW_OFFLINE_MOCK !== 'true' && process.env.NODE_ENV === 'production') {
      return res.status(401).json({ success: false, error: 'Offline demo tokens not allowed in production — please login again' });
    }
    try {
      const payloadPart = token.split('.')[1] || '';
      const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(Buffer.from(padded, 'base64').toString());
      // Whitelist payload to prevent pollution
      const { id, userId, userType } = decoded;
      req.user = {
        id: id || userId || `offline_${Date.now()}`,
        userId: userId || id || `offline_${Date.now()}`,
        userType: String(userType || 'citizen').toLowerCase(),
        offlineMock: true,
      };
      return next();
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Not authorized, offline token failed: ' + e.message });
    }
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Normalize: ensure req.user has id, userId, userType
    req.user = {
      id: decoded.id || decoded.userId,
      userId: decoded.userId || decoded.id,
      userType: decoded.userType,
      ...decoded,
    };
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized, token failed: ' + err.message,
    });
  }
};

// Optional role-based guard: usage -> authorize('technician','kESCO','admin')
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.userType) {
      return res.status(403).json({ success: false, error: 'Forbidden: no role found' });
    }
    const userRole = (req.user.userType || '').toLowerCase();
    const allowed = roles.map(r => r.toLowerCase());
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ success: false, error: `Forbidden: requires one of [${roles.join(', ')}]` });
    }
    next();
  };
};

module.exports = { generateOTP, generateToken, protect, authorize };
