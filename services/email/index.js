'use strict';

const { getGraphAccessToken } = require('./graphClient');
const { sendEmail, sendAgentReplyEmail, sendAutoReplyEmail, sendViaGraph } = require('./emailSender');
const { fetchMessageAttachments, MAX_EMAIL_ATTACHMENT_SIZE } = require('./emailAttachmentService');
const {
    fetchNewGraphEmails,
    syncSentItemsEmails,
    startImapListener,
    getPollerStatus,
    markEmailAsRead
} = require('./emailPoller');

module.exports = {
    sendEmail,
    sendAgentReplyEmail,
    sendAutoReplyEmail,
    sendViaGraph,
    startImapListener,
    fetchNewGraphEmails,
    syncSentItemsEmails,
    fetchMessageAttachments,
    getPollerStatus,
    getGraphAccessToken,
    markEmailAsRead,
    MAX_EMAIL_ATTACHMENT_SIZE
};
