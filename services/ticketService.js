'use strict';

/**
 * ============================================================================
 * EdgeStone Ticketing Service Gateway
 * ============================================================================
 * This service exposes all ticketing operations. For modularity and maintainability,
 * the underlying implementations are divided into focused submodules under ./ticket/:
 *
 *  - ticketSanitizer.js         -> Text cleaning, HTML table preservation & metadata parsing
 *  - ticketThreadingService.js  -> Email threading, Docket # & message reverse-matching
 *  - ticketReplyHandler.js      -> Ingestion of client, vendor & Outlook agent replies
 *  - ticketIngestionService.js  -> Circuit discovery, sender identification & ticket creation
 *  - ticketManagementService.js -> Ticket CRUD, updates, UI replies, auto-replies & deletions
 * ============================================================================
 */

// 1. Text Sanitization & Metadata Parsing Utilities
const {
    stripHtml,
    stripQuotedReply,
    extractMaintenanceMetadata,
    isEmailMatchingClientDomain,
    GENERIC_PUBLIC_DOMAINS
} = require('./ticket/ticketSanitizer');

// 2. Email Threading & Reverse-Matching Engine
const {
    findExistingTicketForReply
} = require('./ticket/ticketThreadingService');

// 3. Reply Ingestion Handlers (Client, Vendor, Agent from Outlook)
const {
    appendClientReplyToTicket,
    appendVendorReplyToTicket,
    appendAgentReplyFromOutlook
} = require('./ticket/ticketReplyHandler');

// 4. Ticket Creation & Ingestion Engine from Incoming Emails
const {
    createTicketFromEmail,
    isAutoReplyEnabled
} = require('./ticket/ticketIngestionService');

// 5. Ticket CRUD, Updates, UI Reply & Lifecycle Management
const {
    generateTicketId,
    getTickets,
    updateTicket,
    replyToTicket,
    sendManualAutoReply,
    deleteTicket
} = require('./ticket/ticketManagementService');

// Export all methods with full IDE autocomplete and reference preservation
module.exports = {
    // Ingestion & Threading
    createTicketFromEmail,
    isAutoReplyEnabled,
    findExistingTicketForReply,
    appendClientReplyToTicket,
    appendVendorReplyToTicket,
    appendAgentReplyFromOutlook,

    // Ticket Management & CRUD
    generateTicketId,
    getTickets,
    updateTicket,
    replyToTicket,
    sendManualAutoReply,
    deleteTicket,

    // Parsing & Sanitization Utilities
    stripHtml,
    stripQuotedReply,
    extractMaintenanceMetadata,
    isEmailMatchingClientDomain,
    GENERIC_PUBLIC_DOMAINS
};
