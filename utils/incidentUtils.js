/**
 * Incident Utility for EdgeStone Ticketing System
 * Computes daily IST boundaries and classifies circuit incidents into:
 * - NEW_INCIDENT
 * - ONGOING_INCIDENT
 * - NEW_AND_ONGOING
 * - RESOLVED_TODAY
 */

/**
 * Returns current IST date string "YYYY-MM-DD"
 */
const getCurrentISTDateStr = () => {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
};

/**
 * Formats "YYYY-MM-DD" into "DD Month YYYY" (e.g. "01 October 2026")
 */
const formatDisplayDate = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const [yyyy, mm, dd] = dateStr.split('-');
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthName = months[parseInt(mm, 10) - 1] || mm;
    return `${dd} ${monthName} ${yyyy}`;
};

/**
 * Returns start and end UTC Date objects corresponding to 00:00:00 and 23:59:59.999 IST
 */
const getISTDayBounds = (dateStr) => {
    const targetDateStr = dateStr || getCurrentISTDateStr();
    const [yyyy, mm, dd] = targetDateStr.split('-').map(Number);

    // 00:00:00.000 IST is equivalent to (Target Date - 5h 30m) in UTC
    // i.e., Date.UTC(yyyy, mm - 1, dd, 0, 0, 0) - (5.5 * 3600 * 1000)
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const startOfDayUTC = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0) - istOffsetMs);
    const endOfDayUTC = new Date(Date.UTC(yyyy, mm - 1, dd, 23, 59, 59, 999) - istOffsetMs);

    return {
        dateStr: targetDateStr,
        displayDate: formatDisplayDate(targetDateStr),
        startUTC: startOfDayUTC,
        endUTC: endOfDayUTC
    };
};

/**
 * Helper to check if a ticket status is considered active/unresolved
 */
const isTicketActive = (status) => {
    if (!status) return false;
    const s = status.toLowerCase().replace(/\s+/g, '-');
    return s === 'open' || s === 'in-progress';
};

/**
 * Helper to check if a ticket was closed
 */
const isTicketClosed = (status) => {
    if (!status) return false;
    return status.toLowerCase() === 'closed';
};

/**
 * Classifies all tickets against circuits for a specified operational date
 */
const classifyCircuitIncidents = (circuits, tickets, bounds) => {
    const { startUTC, endUTC, dateStr } = bounds;

    // Fast lookup map for circuits by multiple identifiers
    const circuitMap = new Map();
    circuits.forEach(c => {
        circuitMap.set(c.id, c);
        if (c.customerCircuitId) circuitMap.set(c.customerCircuitId.toUpperCase().trim(), c);
        if (c.supplierCircuitId) circuitMap.set(c.supplierCircuitId.toUpperCase().trim(), c);
    });

    // Group tickets by circuit
    // Key: Circuit ID (or "UNASSIGNED")
    const circuitIncidents = new Map();

    const getOrCreateGroup = (circuitRecord, fallbackCircuitId) => {
        const key = circuitRecord ? circuitRecord.id : `UNASSIGNED_${fallbackCircuitId || 'GENERAL'}`;
        if (!circuitIncidents.has(key)) {
            circuitIncidents.set(key, {
                circuit: circuitRecord || {
                    id: key,
                    customerCircuitId: fallbackCircuitId || 'General / Unlinked',
                    supplierCircuitId: null,
                    type: 'N/A',
                    client: null,
                    vendor: null
                },
                newTicketsToday: [],
                ongoingTicketsOlder: [],
                resolvedTicketsToday: [],
                allTickets: []
            });
        }
        return circuitIncidents.get(key);
    };

    let totalTicketsRaisedToday = 0;
    let totalResolvedToday = 0;

    // Process all tickets
    tickets.forEach(ticket => {
        const createdAt = new Date(ticket.createdAt);
        const updatedAt = ticket.updatedAt ? new Date(ticket.updatedAt) : createdAt;

        // Try to match circuit
        let matchedCircuit = null;
        const candidateKeys = [
            ticket.circuitId,
            ticket.header
        ].filter(Boolean);

        for (const k of candidateKeys) {
            const clean = String(k).toUpperCase().trim();
            if (circuitMap.has(clean)) {
                matchedCircuit = circuitMap.get(clean);
                break;
            }
        }

        const group = getOrCreateGroup(matchedCircuit, ticket.circuitId);
        group.allTickets.push(ticket);

        const isCreatedToday = createdAt >= startUTC && createdAt <= endUTC;
        const isCreatedBeforeToday = createdAt < startUTC;
        const isUpdatedToday = updatedAt >= startUTC && updatedAt <= endUTC;

        if (isCreatedToday) {
            totalTicketsRaisedToday++;
            group.newTicketsToday.push(ticket);
        }

        if (isCreatedBeforeToday && isTicketActive(ticket.status)) {
            group.ongoingTicketsOlder.push(ticket);
        }

        if (isTicketClosed(ticket.status) && isUpdatedToday) {
            totalResolvedToday++;
            group.resolvedTicketsToday.push(ticket);
        }
    });

    // Classify each circuit that has any incident activity on this date
    const classifiedList = [];
    let newIncidentsCount = 0;
    let ongoingIncidentsCount = 0;
    let resolvedTodayCount = 0;

    const targetDateObj = new Date(`${dateStr}T12:00:00Z`);

    circuitIncidents.forEach((group) => {
        const { circuit, newTicketsToday, ongoingTicketsOlder, resolvedTicketsToday } = group;

        const hasNew = newTicketsToday.length > 0;
        const hasOngoing = ongoingTicketsOlder.length > 0;
        const hasResolved = resolvedTicketsToday.length > 0;

        // If circuit has zero activity for this day, skip it
        if (!hasNew && !hasOngoing && !hasResolved) {
            return;
        }

        let incidentStatus = 'ONGOING_INCIDENT';
        let incidentStatusLabel = 'No New Incident Reported – Ongoing Incident';
        let statusBadgeColor = 'amber';

        if (hasNew && hasOngoing) {
            incidentStatus = 'NEW_AND_ONGOING';
            incidentStatusLabel = 'New Incident Reported & Ongoing Issue';
            statusBadgeColor = 'purple';
            newIncidentsCount++;
            ongoingIncidentsCount++;
        } else if (hasNew) {
            incidentStatus = 'NEW_INCIDENT';
            incidentStatusLabel = 'New Incident Reported';
            statusBadgeColor = 'rose';
            newIncidentsCount++;
        } else if (hasOngoing) {
            incidentStatus = 'ONGOING_INCIDENT';
            incidentStatusLabel = 'No New Incident Reported – Ongoing Incident';
            statusBadgeColor = 'amber';
            ongoingIncidentsCount++;
        } else if (hasResolved) {
            incidentStatus = 'RESOLVED_TODAY';
            incidentStatusLabel = 'Resolved Today';
            statusBadgeColor = 'emerald';
            resolvedTodayCount++;
        }

        // Calculate aging for ongoing tickets
        let agingDays = 1;
        let oldestCreatedAt = null;

        const activeTickets = [...newTicketsToday, ...ongoingTicketsOlder];
        if (activeTickets.length > 0) {
            activeTickets.forEach(t => {
                const tCreated = new Date(t.createdAt);
                if (!oldestCreatedAt || tCreated < oldestCreatedAt) {
                    oldestCreatedAt = tCreated;
                }
            });
            if (oldestCreatedAt) {
                const diffTime = Math.max(0, targetDateObj.getTime() - oldestCreatedAt.getTime());
                agingDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
            }
        }

        // Map relevant tickets into clean DTOs
        const displayTickets = activeTickets.length > 0 ? activeTickets : resolvedTicketsToday;
        const mappedTickets = displayTickets.map(t => ({
            id: t.id,
            ticketId: t.ticketId,
            header: t.header,
            priority: t.priority || 'Medium',
            status: t.status,
            createdAt: t.createdAt,
            date: t.date,
            isNewToday: newTicketsToday.some(nt => nt.id === t.id)
        }));

        classifiedList.push({
            circuitId: circuit.id,
            customerCircuitId: circuit.customerCircuitId || 'N/A',
            supplierCircuitId: circuit.supplierCircuitId || null,
            circuitType: circuit.type || 'UNPROTECTED',
            clientName: circuit.client ? circuit.client.name : 'Unknown Client',
            vendorName: circuit.vendor ? circuit.vendor.name : 'Unknown Vendor',
            incidentStatus,
            incidentStatusLabel,
            statusBadgeColor,
            agingDays,
            firstReportedDate: oldestCreatedAt ? oldestCreatedAt.toISOString().split('T')[0] : dateStr,
            newTicketsCount: newTicketsToday.length,
            ongoingTicketsCount: ongoingTicketsOlder.length,
            totalActiveTickets: activeTickets.length,
            tickets: mappedTickets
        });
    });

    // Sort: New & Critical Incidents first, then Ongoing by aging descending
    classifiedList.sort((a, b) => {
        const priorityOrder = { 'NEW_AND_ONGOING': 1, 'NEW_INCIDENT': 2, 'ONGOING_INCIDENT': 3, 'RESOLVED_TODAY': 4 };
        const orderA = priorityOrder[a.incidentStatus] || 5;
        const orderB = priorityOrder[b.incidentStatus] || 5;
        if (orderA !== orderB) return orderA - orderB;
        return b.agingDays - a.agingDays;
    });

    return {
        date: dateStr,
        displayDate: bounds.displayDate,
        summary: {
            totalTicketsRaisedToday,
            totalImpactedCircuits: classifiedList.filter(c => c.incidentStatus !== 'RESOLVED_TODAY').length,
            newIncidentsCount,
            ongoingIncidentsCount,
            resolvedTodayCount
        },
        circuits: classifiedList
    };
};

module.exports = {
    getCurrentISTDateStr,
    formatDisplayDate,
    getISTDayBounds,
    classifyCircuitIncidents
};
