'use strict';

const {
    stripHtml,
    stripQuotedReply,
    extractMaintenanceMetadata,
    isEmailMatchingClientDomain,
    GENERIC_PUBLIC_DOMAINS
} = require('./ticketSanitizer');

const { findExistingTicketForReply } = require('./ticketThreadingService');

const {
    appendClientReplyToTicket,
    appendVendorReplyToTicket,
    appendAgentReplyFromOutlook
} = require('./ticketReplyHandler');

const { createTicketFromEmail } = require('./ticketIngestionService');

const {
    generateTicketId,
    getTickets,
    updateTicket,
    replyToTicket,
    sendManualAutoReply,
    deleteTicket
} = require('./ticketManagementService');

module.exports = {
    createTicketFromEmail,
    getTickets,
    updateTicket,
    replyToTicket,
    sendManualAutoReply,
    appendClientReplyToTicket,
    appendVendorReplyToTicket,
    appendAgentReplyFromOutlook,
    findExistingTicketForReply,
    stripHtml,
    stripQuotedReply,
    extractMaintenanceMetadata,
    generateTicketId,
    deleteTicket,
    isEmailMatchingClientDomain,
    GENERIC_PUBLIC_DOMAINS
};
