const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const {
    getCurrentISTDateStr,
    getISTDayBounds,
    classifyCircuitIncidents
} = require('../utils/incidentUtils');

/**
 * GET /api/dashboard/circuit-incidents?date=YYYY-MM-DD&status=ALL&search=...
 * Returns daily ticket and circuit visibility breakdown
 */
const getCircuitIncidents = async (req, res, next) => {
    try {
        const { date, status, search } = req.query;
        const targetDateStr = date || getCurrentISTDateStr();

        logger.debug(`📊 [DASHBOARD] Fetching daily circuit incidents for date: ${targetDateStr}`);

        const bounds = getISTDayBounds(targetDateStr);

        // Fetch all circuits with relations
        const circuits = await prisma.circuit.findMany({
            include: {
                client: { select: { id: true, name: true } },
                vendor: { select: { id: true, name: true } },
                vendorCircuits: { select: { supplierCircuitId: true } }
            }
        });

        // Fetch tickets created up to end of this operational day
        // For performance, we fetch tickets relevant to this day:
        // 1. Created on or before the end of the target day AND
        // 2. Either created today OR status is Open/In Progress OR closed today
        const tickets = await prisma.ticket.findMany({
            where: {
                createdAt: {
                    lte: bounds.endUTC
                }
            },
            select: {
                id: true,
                ticketId: true,
                header: true,
                status: true,
                priority: true,
                circuitId: true,
                clientId: true,
                vendorId: true,
                createdAt: true,
                updatedAt: true,
                date: true
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        const result = classifyCircuitIncidents(circuits, tickets, bounds);

        // Apply client filters if requested
        let filteredCircuits = result.circuits;

        if (status && status !== 'ALL') {
            const filterUpper = status.toUpperCase();
            if (filterUpper === 'NEW') {
                filteredCircuits = filteredCircuits.filter(c => c.incidentStatus === 'NEW_INCIDENT' || c.incidentStatus === 'NEW_AND_ONGOING');
            } else if (filterUpper === 'ONGOING') {
                filteredCircuits = filteredCircuits.filter(c => c.incidentStatus === 'ONGOING_INCIDENT' || c.incidentStatus === 'NEW_AND_ONGOING');
            } else if (filterUpper === 'RESOLVED') {
                filteredCircuits = filteredCircuits.filter(c => c.incidentStatus === 'RESOLVED_TODAY');
            }
        }

        if (search && search.trim()) {
            const q = search.trim().toLowerCase();
            filteredCircuits = filteredCircuits.filter(c => {
                const custMatch = c.customerCircuitId && c.customerCircuitId.toLowerCase().includes(q);
                const suppMatch = c.supplierCircuitId && c.supplierCircuitId.toLowerCase().includes(q);
                const clientMatch = c.clientName && c.clientName.toLowerCase().includes(q);
                const vendorMatch = c.vendorName && c.vendorName.toLowerCase().includes(q);
                const ticketMatch = c.tickets && c.tickets.some(t => 
                    (t.ticketId && t.ticketId.toLowerCase().includes(q)) ||
                    (t.header && t.header.toLowerCase().includes(q))
                );
                return custMatch || suppMatch || clientMatch || vendorMatch || ticketMatch;
            });
        }

        res.json({
            date: result.date,
            displayDate: result.displayDate,
            summary: result.summary,
            circuits: filteredCircuits
        });
    } catch (error) {
        logger.error(`🚨 [DASHBOARD] Error fetching circuit incidents: ${error.message}`);
        next(error);
    }
};

module.exports = {
    getCircuitIncidents
};
