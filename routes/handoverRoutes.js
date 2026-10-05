const express = require('express');
const router = express.Router();
const handoverController = require('../controllers/handoverController');
const { protect } = require('../middlewares/authMiddleware');

// Get current active shift handover (IST-based)
router.get('/current', protect, handoverController.getCurrentHandover);

// Get handover for specific date & shift
router.get('/by-date-shift', protect, handoverController.getHandoverByDateAndShift);

// Get historical handovers
router.get('/history', protect, handoverController.getHandoverHistory);

// Create or update handover
router.put('/', protect, handoverController.upsertHandover);

// Acknowledge handover
router.patch('/:id/acknowledge', protect, handoverController.acknowledgeHandover);

// Carry forward content from previous shift
router.post('/carry-forward', protect, handoverController.carryForwardPreviousShift);

module.exports = router;
