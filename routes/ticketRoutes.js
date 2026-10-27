const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const workNoteController = require('../controllers/workNoteController');
const activityLogController = require('../controllers/activityLogController');

const { protect, requireManagerOrSuperAdmin } = require('../middlewares/authMiddleware');

router.get('/', protect, ticketController.getTickets);

// Day-wise ticket tracking summary (powered by services/ticket/smartTicketSorter.js)
router.get('/day-summary', protect, async (req, res) => {
    try {
        const { getTickets } = require('../services/ticket/ticketManagementService');
        const { buildDaySummary, toISTDate } = require('../services/ticket/smartTicketSorter');
        const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : toISTDate(new Date());
        const tickets = await getTickets();
        res.json(buildDaySummary(tickets, day));
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});
router.post('/', protect, ticketController.createTicket);
router.patch('/:id', protect, ticketController.updateTicket); // Update ticket
router.patch('/:id/sla-toggle', protect, ticketController.toggleSla);
router.post('/:id/reply', protect, ticketController.replyTicket);
router.get('/:id/vendor-emails', protect, ticketController.getVendorEmails);
router.post('/:id/vendor-reply', protect, ticketController.replyVendorTicket);

// Work Notes routes
router.post('/:ticketId/work-notes', protect, workNoteController.createWorkNote);
router.get('/:ticketId/work-notes', protect, workNoteController.getWorkNotes);

// Activity Logs routes
router.get('/:id/activity-logs', protect, activityLogController.getActivityLogs);
router.get('/:ticketId/activity-logs', protect, activityLogController.getActivityLogs);

router.post('/:id/auto-reply', protect, ticketController.sendAutoReply);
router.delete('/:id', protect, requireManagerOrSuperAdmin, ticketController.deleteTicket);

module.exports = router;
