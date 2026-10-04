const { z } = require('zod');
const { validationResult } = require('express-validator');

// Generic zod validator for body / query / params
function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const data = req[source];
      const parsed = schema.parse(data);
      req[source] = parsed; // use sanitized/parsed
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
        });
      }
      next(err);
    }
  };
}

// Express-validator result checker — use after chain like [body('email').isEmail(), checkValidation]
function checkValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: 'Validation failed', details: errors.array() });
  }
  next();
}

// Export common schemas for reuse
const schemas = {
  sendOtp: z.object({
    email: z.string().email('Invalid email'),
    meterNumber: z.string().optional(),
    technicianId: z.string().optional(),
    registrationNumber: z.string().optional(),
    phone: z.string().optional(),
  }).passthrough(),
  verifyOtp: z.object({
    email: z.string().email('Invalid email'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
  }).passthrough(),
  complaint: z.object({
    problemVariant: z.string().min(1),
    description: z.string().min(5).max(2000),
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  }).passthrough(),
};

module.exports = { validate, checkValidation, schemas, z };
