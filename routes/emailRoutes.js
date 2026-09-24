const express = require('express');
const router = express.Router();
const emailController = require('../controllers/emailController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/webhook', emailController.handleWebhook);
router.get('/suggestions', protect, emailController.getSuggestions);
router.get('/status', emailController.getStatus);
router.post('/poll', emailController.triggerPoll);

module.exports = router;

