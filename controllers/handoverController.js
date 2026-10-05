const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const {
    SHIFT_CONFIG,
    resolveShiftInfo,
    formatDateDisplay,
    getPreviousShift,
    getNextShift
} = require('../utils/shiftUtils');

/**
 * GET /api/handovers/current
 * Resolves active shift and date according to IST, returning or initializing current handover
 */
const getCurrentHandover = async (req, res, next) => {
    try {
        const activeInfo = resolveShiftInfo(new Date());
        const { date, shift, shiftName, timeRange, displayTitle } = activeInfo;

        let handover = await prisma.shiftHandover.findUnique({
            where: {
                date_shift: { date, shift }
            }
        });

        // If not found in DB, check if there's any legacy note to migrate
        if (!handover) {
            let legacyContent = '';
            try {
                const legacyNote = await prisma.globalNote.findUnique({
                    where: { id: 'global-note' }
                });
                if (legacyNote && legacyNote.content) {
                    legacyContent = legacyNote.content;
                }
            } catch (err) {
                // Ignore legacy read errors
            }

            // Return a virtual draft without immediately forcing DB write
            return res.json({
                id: null,
                date,
                shift,
                shiftName,
                timeRange,
                displayTitle,
                content: legacyContent,
                criticalTickets: [],
                pendingTasks: [],
                status: 'DRAFT',
                outgoingAgent: null,
                incomingAgent: null,
                acknowledgedAt: null,
                isNew: true
            });
        }

        res.json({
            ...handover,
            timeRange,
            displayTitle
        });
    } catch (error) {
        logger.error(`🚨 [HANDOVER] Error fetching current handover: ${error.message}`);
        next(error);
    }
};

/**
 * GET /api/handovers/by-date-shift?date=YYYY-MM-DD&shift=A
 * Fetches handover for a specific date and shift
 */
const getHandoverByDateAndShift = async (req, res, next) => {
    try {
        const { date, shift } = req.query;

        if (!date || !shift) {
            return res.status(400).json({ message: 'Both date (YYYY-MM-DD) and shift (A|B|C) are required.' });
        }

        const validShift = shift.toUpperCase();
        if (!['A', 'B', 'C'].includes(validShift)) {
            return res.status(400).json({ message: 'Invalid shift. Must be A, B, or C.' });
        }

        const shiftMeta = SHIFT_CONFIG[validShift] || { name: 'Unknown', timeRange: '' };
        const displayTitle = `${formatDateDisplay(date)} – ${validShift} Shift Handover (${shiftMeta.name})`;

        const handover = await prisma.shiftHandover.findUnique({
            where: {
                date_shift: {
                    date,
                    shift: validShift
                }
            }
        });

        if (!handover) {
            return res.json({
                id: null,
                date,
                shift: validShift,
                shiftName: shiftMeta.name,
                timeRange: shiftMeta.timeRange,
                displayTitle,
                content: '',
                criticalTickets: [],
                pendingTasks: [],
                status: 'DRAFT',
                outgoingAgent: null,
                incomingAgent: null,
                acknowledgedAt: null,
                isNew: true
            });
        }

        res.json({
            ...handover,
            timeRange: shiftMeta.timeRange,
            displayTitle
        });
    } catch (error) {
        logger.error(`🚨 [HANDOVER] Error fetching handover by date & shift: ${error.message}`);
        next(error);
    }
};

/**
 * PUT /api/handovers
 * Upserts handover for a specific date & shift
 */
const upsertHandover = async (req, res, next) => {
    try {
        const {
            date,
            shift,
            content,
            criticalTickets = [],
            pendingTasks = [],
            status = 'DRAFT'
        } = req.body;

        if (!date || !shift) {
            return res.status(400).json({ message: 'Date and shift are required.' });
        }

        const validShift = shift.toUpperCase();
        const shiftMeta = SHIFT_CONFIG[validShift] || { name: 'Morning' };
        const agentName = req.user ? req.user.name : 'Unknown Agent';
        const agentId = req.user ? req.user.id : null;

        const updated = await prisma.shiftHandover.upsert({
            where: {
                date_shift: {
                    date,
                    shift: validShift
                }
            },
            update: {
                content: content !== undefined ? content : '',
                criticalTickets,
                pendingTasks,
                status,
                outgoingAgent: agentName,
                outgoingAgentId: agentId
            },
            create: {
                date,
                shift: validShift,
                shiftName: shiftMeta.name,
                content: content !== undefined ? content : '',
                criticalTickets,
                pendingTasks,
                status,
                outgoingAgent: agentName,
                outgoingAgentId: agentId
            }
        });

        // Also mirror content to legacy GlobalNote so older components never break
        try {
            await prisma.globalNote.upsert({
                where: { id: 'global-note' },
                update: { content: content || '', updatedBy: `${agentName} (${validShift} Shift)` },
                create: { id: 'global-note', content: content || '', updatedBy: `${agentName} (${validShift} Shift)` }
            });
        } catch (legacyErr) {
            // Non-blocking
        }

        logger.info(`📝 [HANDOVER] ✅ Handover updated for ${date} [Shift ${validShift}] by ${agentName}`);

        res.json({
            ...updated,
            timeRange: shiftMeta.timeRange,
            displayTitle: `${formatDateDisplay(date)} – ${validShift} Shift Handover (${shiftMeta.name})`
        });
    } catch (error) {
        logger.error(`🚨 [HANDOVER] Error saving handover: ${error.message}`);
        next(error);
    }
};

/**
 * PATCH /api/handovers/:id/acknowledge
 * Incoming agent acknowledges the handover
 */
const acknowledgeHandover = async (req, res, next) => {
    try {
        const { id } = req.params;
        const agentName = req.user ? req.user.name : 'Unknown Agent';
        const agentId = req.user ? req.user.id : null;

        const handover = await prisma.shiftHandover.findUnique({
            where: { id }
        });

        if (!handover) {
            return res.status(404).json({ message: 'Handover record not found.' });
        }

        const acknowledged = await prisma.shiftHandover.update({
            where: { id },
            data: {
                status: 'ACKNOWLEDGED',
                incomingAgent: agentName,
                incomingAgentId: agentId,
                acknowledgedAt: new Date()
            }
        });

        logger.info(`🤝 [HANDOVER] Shift Handover acknowledged by ${agentName} for ${acknowledged.date} Shift ${acknowledged.shift}`);
        res.json(acknowledged);
    } catch (error) {
        logger.error(`🚨 [HANDOVER] Error acknowledging handover: ${error.message}`);
        next(error);
    }
};

/**
 * GET /api/handovers/history
 * Retrieves historical handovers with filters
 */
const getHandoverHistory = async (req, res, next) => {
    try {
        const { shift, search, limit = 45 } = req.query;

        const whereClause = {};

        if (shift && ['A', 'B', 'C'].includes(shift.toUpperCase())) {
            whereClause.shift = shift.toUpperCase();
        }

        if (search && search.trim()) {
            whereClause.OR = [
                { content: { contains: search.trim(), mode: 'insensitive' } },
                { outgoingAgent: { contains: search.trim(), mode: 'insensitive' } },
                { incomingAgent: { contains: search.trim(), mode: 'insensitive' } }
            ];
        }

        const records = await prisma.shiftHandover.findMany({
            where: whereClause,
            orderBy: [
                { date: 'desc' },
                { shift: 'desc' }
            ],
            take: Math.min(Number(limit) || 45, 120)
        });

        // Group by Date for cleaner presentation
        const dateGroups = {};
        for (const rec of records) {
            if (!dateGroups[rec.date]) {
                dateGroups[rec.date] = {
                    date: rec.date,
                    displayDate: formatDateDisplay(rec.date),
                    shifts: {}
                };
            }
            dateGroups[rec.date].shifts[rec.shift] = {
                ...rec,
                shiftMeta: SHIFT_CONFIG[rec.shift]
            };
        }

        res.json({
            records,
            groupedByDate: Object.values(dateGroups)
        });
    } catch (error) {
        logger.error(`🚨 [HANDOVER] Error fetching history: ${error.message}`);
        next(error);
    }
};

/**
 * POST /api/handovers/carry-forward
 * Retrieves unresolved tasks and content from immediate previous shift to carry forward
 */
const carryForwardPreviousShift = async (req, res, next) => {
    try {
        const { date, shift } = req.body;

        if (!date || !shift) {
            return res.status(400).json({ message: 'Current date and shift are required.' });
        }

        const prev = getPreviousShift(date, shift.toUpperCase());

        const prevHandover = await prisma.shiftHandover.findUnique({
            where: {
                date_shift: {
                    date: prev.date,
                    shift: prev.shift
                }
            }
        });

        if (!prevHandover || !prevHandover.content) {
            return res.json({
                found: false,
                previousInfo: prev,
                message: `No previous handover notes found for ${formatDateDisplay(prev.date)} – Shift ${prev.shift}.`
            });
        }

        res.json({
            found: true,
            previousInfo: {
                ...prev,
                displayDate: formatDateDisplay(prev.date),
                title: `${formatDateDisplay(prev.date)} – ${prev.shift} Shift Handover (${prev.shiftName})`
            },
            handover: prevHandover
        });
    } catch (error) {
        logger.error(`🚨 [HANDOVER] Error fetching previous shift data: ${error.message}`);
        next(error);
    }
};

module.exports = {
    getCurrentHandover,
    getHandoverByDateAndShift,
    upsertHandover,
    acknowledgeHandover,
    getHandoverHistory,
    carryForwardPreviousShift
};
