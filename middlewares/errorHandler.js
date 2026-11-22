const logger = require('../utils/logger');

const isTechnicalOrDatabaseError = (err) => {
    if (!err) return false;
    const name = String(err.name || '');
    const msg = String(err.message || '');
    return (
        name.includes('Prisma') ||
        msg.includes('prisma.') ||
        msg.includes('PrismaClient') ||
        msg.includes('Invalid `prisma') ||
        msg.includes("Can't reach database") ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ENOTFOUND') ||
        /\{\s*where:\s*\{/.test(msg)
    );
};

const errorHandler = (err, req, res, next) => {
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

    logger.error(`❌ ${statusCode} Error: ${err.message}`, { stack: err.stack });

    const isTechErr = isTechnicalOrDatabaseError(err);
    const isReplyRoute = req?.originalUrl && (req.originalUrl.includes('/vendor-reply') || req.originalUrl.includes('/reply'));

    const userFacingMessage = isTechErr
        ? (isReplyRoute
            ? 'Safety mechanism active: Outbound email is temporarily paused while verifying thread & client confidentiality. Please refresh and try again.'
            : 'Safety mechanism active: This operation is temporarily restricted by system safeguards. Please refresh and try again shortly.')
        : (err.message || 'Unable to process request at the moment. Please try again.');

    res.status(statusCode);

    res.json({
        message: userFacingMessage,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
};

module.exports = { errorHandler };
