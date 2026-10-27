require('dotenv').config();
const { getGraphAccessToken } = require('../services/email/graphClient');

async function test() {
  const token = await getGraphAccessToken();
  const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/inbox/messages?$top=10&$select=id,internetMessageId,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  console.log('Recent 10 inbox messages:');
  data.value?.forEach((m, i) => {
    console.log(`[${i+1}] ${m.receivedDateTime} | From: ${m.from?.emailAddress?.address} | Subject: ${m.subject}`);
    console.log(`     MessageId: ${m.internetMessageId}`);
    console.log(`     Preview: ${m.bodyPreview?.substring(0, 100)}`);
  });
}
test().catch(console.error);
