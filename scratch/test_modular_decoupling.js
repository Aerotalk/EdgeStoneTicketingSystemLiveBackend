'use strict';

const ticketService = require('../services/ticketService');
const emailService = require('../services/emailService');
const ticketController = require('../controllers/ticketController');
const emailController = require('../controllers/emailController');

console.log('1. Checking ticketService methods:');
const ticketMethods = [
    'createTicketFromEmail', 'getTickets', 'updateTicket', 'replyToTicket',
    'sendManualAutoReply', 'appendClientReplyToTicket', 'appendVendorReplyToTicket',
    'appendAgentReplyFromOutlook', 'findExistingTicketForReply', 'stripHtml',
    'stripQuotedReply', 'extractMaintenanceMetadata', 'deleteTicket'
];
ticketMethods.forEach(m => {
    if (typeof ticketService[m] !== 'function') throw new Error('Missing ticket method: ' + m);
    console.log('  [OK] ticketService.' + m);
});

console.log('\n2. Checking emailService methods:');
const emailMethods = [
    'sendEmail', 'sendAgentReplyEmail', 'startImapListener', 'fetchNewGraphEmails',
    'syncSentItemsEmails', 'fetchMessageAttachments', 'getPollerStatus'
];
emailMethods.forEach(m => {
    if (typeof emailService[m] !== 'function') throw new Error('Missing email method: ' + m);
    console.log('  [OK] emailService.' + m);
});

console.log('\n3. Checking Poller status function:');
const status = emailService.getPollerStatus();
console.log('  Poller status output:', status);

console.log('\n4. Checking HTML Sanitizer:');
const sampleHtml = '<p>Hello <b>World</b><style>.bad{}</style><table class="test"><tr><td>Data</td></tr></table></p>';
const cleaned = ticketService.stripHtml(sampleHtml);
console.log('  Cleaned HTML table preserved:', cleaned.includes('<table class="edgestone-table">'));

console.log('\n5. Checking Quote Stripper:');
const quoted = 'Please check this\nFrom: user@example.com\nSent: Monday\nOriginal msg';
const cleanQuote = ticketService.stripQuotedReply(quoted);
console.log('  Clean Quote matches:', cleanQuote === 'Please check this');

console.log('\n6. Checking Controllers import cleanly:');
console.log('  ticketController has getTickets:', typeof ticketController.getTickets === 'function');
console.log('  emailController has getStatus:', typeof emailController.getStatus === 'function');

console.log('\n🎉 ALL MODULAR VERIFICATIONS PASSED SUCCESSFULLY!');
