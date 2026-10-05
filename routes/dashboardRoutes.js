const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { protect } = require('../middlewares/authMiddleware');

// GET /api/dashboard/circuit-incidents
router.get('/circuit-incidents', protect, dashboardController.getCircuitIncidents);

module.exports = router;
