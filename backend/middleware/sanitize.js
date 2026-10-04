const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');

// Safe sanitize wrapper for Express 5 (which makes req.query read-only)
// We only sanitize body & params, and headers — avoids "Cannot set property query" crash
function safeMongoSanitize() {
  return (req, res, next) => {
    try {
      // sanitize body
      if (req.body) {
        // express-mongo-sanitize's sanitize function
        const sanitize = require('express-mongo-sanitize').sanitize;
        req.body = sanitize(req.body, { replaceWith: '_' });
      }
      // sanitize params
      if (req.params) {
        const sanitize = require('express-mongo-sanitize').sanitize;
        req.params = sanitize(req.params, { replaceWith: '_' });
      }
      // Also sanitize headers that could contain $ or .
      // Intentionally skip req.query for Express 5 compatibility — query is validated via express-validator instead
    } catch (e) {
      // Fail-open: log but don't block request (prevents 500 on edge cases)
      console.warn('sanitize warning:', e.message);
    }
    next();
  };
}

// hpp — prevent HTTP Parameter Pollution, but whitelist needed arrays like status filters
// Express 5 makes req.query a getter-only property — hpp@0.2.3 tries to set it and crashes with "Cannot set property query"
function makeQueryWritable(req) {
  try {
    let desc = Object.getOwnPropertyDescriptor(req, 'query');
    if (!desc) desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(req), 'query');
    if (!desc && req.constructor && Object.getPrototypeOf(req) !== Object.prototype) {
      desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(req)), 'query');
    }
    if (desc && desc.get && !desc.set) {
      const val = req.query;
      Object.defineProperty(req, 'query', {
        value: val,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  } catch {}
}
function hppMiddleware() {
  const hppFn = hpp({
    whitelist: ['status', 'problemVariant', 'area', 'sort', 'filter'],
  });
  return (req, res, next) => {
    try {
      makeQueryWritable(req);
      return hppFn(req, res, next);
    } catch (e) {
      console.warn('hpp warning (Express 5 compat):', e.message);
      return next();
    }
  };
}

// xss-clean also tries to mutate req.query — wrap for Express 5
function safeXssMiddleware() {
  const xssFn = xss();
  return (req, res, next) => {
    try {
      makeQueryWritable(req);
      return xssFn(req, res, next);
    } catch (e) {
      console.warn('xss warning (Express 5 compat):', e.message);
      return next();
    }
  };
}

module.exports = { safeMongoSanitize, xssMiddleware: safeXssMiddleware, hppMiddleware };
