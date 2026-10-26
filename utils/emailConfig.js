'use strict';

/**
 * Determines whether client auto-reply is enabled via environment variables.
 * Supported env variables: AUTOREPLY, AUTO_REPLY, ENABLE_AUTO_REPLY, AUTO_REPLY_ENABLED
 * Returns true by default unless explicitly disabled ('false', '0', 'off', 'disabled', 'no', 'none').
 * Robust against leading/trailing spaces, surrounding quotes, and case variations:
 * e.g., ' false', ' "false" ', 'FALSE', '0', 'off', 'disabled', 'no'.
 */
const isAutoReplyEnabled = () => {
    const rawVal = process.env.AUTOREPLY ?? process.env.AUTO_REPLY ?? process.env.ENABLE_AUTO_REPLY ?? process.env.AUTO_REPLY_ENABLED;
    if (rawVal === undefined || rawVal === null) {
        return true;
    }
    const trimmed = String(rawVal).trim();
    if (trimmed === '') {
        return true;
    }
    const unquoted = trimmed.replace(/^["']|["']$/g, '').trim().toLowerCase();
    const disabledValues = ['false', '0', 'off', 'disabled', 'no', 'none'];
    return !disabledValues.includes(unquoted);
};

module.exports = {
    isAutoReplyEnabled
};
