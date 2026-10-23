'use strict';

const logger = require('../../utils/logger');

let graphAccessToken = null;
let tokenExpiresAt = 0;

// Shared Set of processed Microsoft Graph message IDs and internetMessageIds
// to prevent duplicate processing between sender, inbox poller, and sent-items sync.
const processedGraphIds = new Set();

const isGraphIdProcessed = (id) => {
    if (!id) return false;
    return processedGraphIds.has(id);
};

const markGraphIdProcessed = (id) => {
    if (!id) return;
    processedGraphIds.add(id);
};

const getGraphAccessToken = async () => {
    const tenantId = process.env.TENANT_ID;
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        throw new Error('Missing MS Graph API configuration.');
    }

    if (graphAccessToken && Date.now() < tokenExpiresAt) {
        return graphAccessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const tokenData = new URLSearchParams({
        client_id: clientId,
        scope: 'https://graph.microsoft.com/.default',
        client_secret: clientSecret,
        grant_type: 'client_credentials'
    });

    const response = await fetch(tokenUrl, {
        method: 'POST',
        body: tokenData,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = await response.json();
    if (!response.ok) {
        throw new Error(`Graph Token Error: ${result.error?.message}`);
    }

    graphAccessToken = result.access_token;
    tokenExpiresAt = Date.now() + (result.expires_in * 1000) - 300000;
    return graphAccessToken;
};

module.exports = {
    getGraphAccessToken,
    isGraphIdProcessed,
    markGraphIdProcessed,
    processedGraphIds
};
