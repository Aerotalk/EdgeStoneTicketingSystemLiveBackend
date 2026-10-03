const slaRecordService = require('../services/slaRecordService');
const logger = require('../utils/logger');

exports.getAllSLARecords = async (req, res) => {
    try {
        const { search, filter, customStart, customEnd, type } = req.query;
        logger.debug('🐞 ⏱️ [SLA] 📝 Request received: getAllSLARecords');
        const data = await slaRecordService.getAllSLARecords({ search, filter, customStart, customEnd, type });
        res.status(200).json({ success: true, data });
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error fetching SLA records:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch SLA records' });
    }
};

exports.exportSLARecords = async (req, res) => {
    try {
        const { search, filter, customStart, customEnd, type } = req.query;
        logger.debug('🐞 ⏱️ [SLA] 📝 Request received: exportSLARecords (Rich Excel)');
        
        const excelExportService = require('../services/excelExportService');
        const workbook = await excelExportService.generateRichSLAExcel({ search, filter, customStart, customEnd, type });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="SLA_Financial_Report_${new Date().toISOString().split('T')[0]}.xlsx"`);
        
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error exporting SLA records:', error);
        res.status(500).json({ success: false, message: 'Failed to export SLA records' });
    }
};

exports.getSLARecordsByTicketId = async (req, res) => {
    try {
        const { ticketId } = req.params;
        const records = await slaRecordService.getSLARecordsByTicketId(ticketId);

        res.status(200).json({ success: true, data: records });
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error fetching SLA records by ticket:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch SLA records' });
    }
};

exports.createSLARecord = async (req, res) => {
    try {
        const { id, ticketId, startDate, startTime } = req.body;
        const newRecord = await slaRecordService.createSLARecord({ id, ticketId, startDate, startTime });

        res.status(201).json({ success: true, data: newRecord });
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error creating SLA record:', error);
        res.status(500).json({ success: false, message: 'Failed to create SLA record' });
    }
};

exports.updateSLAClosure = async (req, res) => {
    try {
        const { id } = req.params;
        const { closeDate, closedTime } = req.body;

        const updatedRecord = await slaRecordService.updateSLAClosure(id, closeDate, closedTime);

        res.status(200).json({ success: true, data: updatedRecord });
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error updating SLA closure:', error);
        if (error.message === 'SLA record not found') {
            return res.status(404).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: 'Failed to update SLA closure' });
    }
};

exports.manualUpdate = async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, startTime, closeDate, closedTime, timeZone, ticketId, type } = req.body;
        
        const agentName = req.user ? req.user.name : 'Agent';
        logger.info(`⏱️ [SLA] 🔄 ${agentName} manually updating SLA ${id}`);
        
        const prisma = require('../utils/prisma');
        const targetType = (type || 'CLIENT').toUpperCase();

        let existing = await prisma.sLARecord.findUnique({ where: { id } });
        if (!existing) {
            // Check if id is actually a ticketId
            existing = await prisma.sLARecord.findFirst({
                where: {
                    ticketId: id,
                    type: targetType
                }
            });
        }
        if (!existing && ticketId) {
            existing = await prisma.sLARecord.findFirst({
                where: {
                    ticketId: ticketId,
                    type: targetType
                }
            });
        }

        // Auto-create/upsert the SLARecord if not found
        if (!existing) {
            const actualTicketId = ticketId || id;
            const ticket = await prisma.ticket.findFirst({
                where: {
                    OR: [
                        { id: actualTicketId },
                        { ticketId: actualTicketId }
                    ]
                }
            });

            if (!ticket) {
                return res.status(404).json({ success: false, message: 'Ticket/SLA record not found' });
            }

            existing = await prisma.sLARecord.create({
                data: {
                    ticketId: ticket.id,
                    type: targetType,
                    startDate: startDate || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
                    startTime: startTime || '00:00 hrs',
                    closeDate: closeDate || null,
                    closedTime: closedTime || null,
                    timeZone: timeZone || 'UTC',
                    status: 'Safe',
                    compensation: '-',
                    statusReason: `${targetType} SLA initialized`
                }
            });
            logger.info(`⏱️ [SLA] 🆕 Created SLARecord ${existing.id} for ticket ${ticket.ticketId} (${targetType})`);
        }
        
        const updatedRecord = await prisma.sLARecord.update({
            where: { id: existing.id },
            data: {
                ...(startDate !== undefined && { startDate }),
                ...(startTime !== undefined && { startTime }),
                ...(closeDate !== undefined && { closeDate }),
                ...(closedTime !== undefined && { closedTime }),
                ...(timeZone !== undefined && { timeZone })
            }
        });
        
        // --- Trigger Compensation Engine if start and closure times are set ---
        if (
            updatedRecord.startDate && updatedRecord.startDate !== '-' &&
            updatedRecord.startTime && updatedRecord.startTime !== '-' &&
            updatedRecord.closeDate && updatedRecord.closeDate !== '-' &&
            updatedRecord.closedTime && updatedRecord.closedTime !== '-'
        ) {
             const slaRecordService = require('../services/slaRecordService');
             await slaRecordService.updateSLAClosure(existing.id, updatedRecord.closeDate, updatedRecord.closedTime, existing);
             const finalRecord = await prisma.sLARecord.findUnique({ where: { id: existing.id } });
             return res.status(200).json({ success: true, data: finalRecord });
        } else {
             // If close date or time is unset/hyphen, reset compensation to '-' and status to Safe
             const finalRecord = await prisma.sLARecord.update({
                 where: { id: existing.id },
                 data: {
                     compensation: '-',
                     status: 'Safe',
                     statusReason: 'SLA closure time not set'
                 }
             });
             return res.status(200).json({ success: true, data: finalRecord });
        }
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error manually updating SLA:', error);
        res.status(500).json({ success: false, message: 'Failed to manually update SLA' });
    }
};

exports.updateSLARecordStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        if (!status || !['Breached', 'Safe'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        if (!reason) {
            return res.status(400).json({ success: false, message: 'Reason is required for status change' });
        }

        const agentName = req.user ? req.user.name : 'Agent';
        logger.info(`⏱️ [SLA] 🔄 ${agentName} updating SLA record ${id} status to ${status}. Reason: ${reason}`);
        
        const updatedRecord = await slaRecordService.updateSLARecordStatus(id, status, reason, agentName);

        res.status(200).json({ success: true, message: 'SLA record updated successfully', data: updatedRecord });
    } catch (error) {
        logger.error('🚨 ⏱️ [SLA] ❌ Error updating SLA record:', error);
        if (error.message === 'SLA record not found') {
            return res.status(404).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: 'Failed to update SLA record' });
    }
};
