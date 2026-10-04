const winston = require('winston');
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'bijlisathi-api' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, stack }) => {
          return `${timestamp} [${level}]: ${stack || message}`;
        })
      ),
    }),
  ],
});

// In production also log to file if writable (Railway supports /tmp)
if (isProd) {
  try {
    logger.add(new winston.transports.File({ filename: path.join('/tmp', 'bijlisathi-error.log'), level: 'error', maxsize: 5 * 1024 * 1024 }));
    logger.add(new winston.transports.File({ filename: path.join('/tmp', 'bijlisathi-combined.log'), maxsize: 10 * 1024 * 1024 }));
  } catch {}
}

module.exports = logger;
