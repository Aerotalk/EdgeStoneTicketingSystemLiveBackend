'use strict';

/**
 * ============================================================================
 * EdgeStone Email Service Gateway
 * ============================================================================
 * This service exposes all Microsoft Graph email operations.
 * The underlying implementations are divided into focused submodules under ./email/:
 *
 *  - graphClient.js            -> MS Graph OAuth token acquisition & ID deduplication
 *  - emailSender.js            -> Outbound email sending, inline CIDs, draft upload sessions
 *  - emailAttachmentService.js -> Attachment downloading, raw $value streaming & storage
 *  - emailPoller.js            -> Inbox & Sent Items polling, loopback checks & poller status
 * ============================================================================
 */

// 1. MS Graph OAuth Token Client & Processed ID Cache
const {
    getGraphAccessToken,
    isGraphIdProcessed,
    markGraphIdProcessed,
    processedGraphIds
} = require('./email/graphClient');

// 2. Outbound Email Transmission
const {
    sendEmail,
    sendAgentReplyEmail,
    sendViaGraph
} = require('./email/emailSender');

// 3. Attachment Downloading & File Storage
const {
    fetchMessageAttachments,
    MAX_EMAIL_ATTACHMENT_SIZE
} = require('./email/emailAttachmentService');

// 4. Inbound Inbox & Sent Items Synchronization Poller
const {
    fetchNewGraphEmails,
    syncSentItemsEmails,
    startImapListener,
    getPollerStatus,
    markEmailAsRead
} = require('./email/emailPoller');

// Export all methods with full IDE autocomplete and reference preservation
module.exports = {
    // Outbound Sending
    sendEmail,
    sendAgentReplyEmail,
    sendViaGraph,

    // Poller & Lifecycle
    startImapListener,
    fetchNewGraphEmails,
    syncSentItemsEmails,
    getPollerStatus,
    markEmailAsRead,

    // Attachments & Tokens
    fetchMessageAttachments,
    getGraphAccessToken,
    MAX_EMAIL_ATTACHMENT_SIZE,

    // Deduplication Helpers
    isGraphIdProcessed,
    markGraphIdProcessed,
    processedGraphIds
};
