import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define log level based on environment
const level = process.env.LOG_LEVEL || 'debug';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const logger = winston.createLogger({
  level,
  format: logFormat,
  transports: [
    // Write all errors to error.log
    new winston.transports.File({ 
      filename: path.join(__dirname, '../storage/logs/error.log'), 
      level: 'error' 
    }),
    // Write all logs to combined.log
    new winston.transports.File({ 
      filename: path.join(__dirname, '../storage/logs/combined.log') 
    })
  ]
});

// If we are not in production, or if we want console logs, add console transport
logger.add(new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  )
}));

export default logger;
