'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
process.env.AUTOREPLY = 'false';
const prisma = require('../models/index');
const { getGraphAccessToken } = require('../services/email/graphClient');
const { fetchMessageAttachments } = require('../services/email/emailAttachmentService');
const { createTicketFromEmail } = require('../services/ticket/ticketIngestionService');

async function main() {
    console.log('\n=== 4. BACKFILLING PCCW OUTAGE NOTIFICATION INC000011767887 FROM GRAPH ===');
    const existingInc = await prisma.ticket.findFirst({
        where: { header: { contains: 'INC000011767887', mode: 'insensitive' } }
    });
    if (existingInc) {
        await prisma.reply.deleteMany({ where: { ticketId: existingInc.id } });
        await prisma.activityLog.deleteMany({ where: { ticketId: existingInc.id } });
        await prisma.ticket.delete({ where: { id: existingInc.id } });
        console.log(`Cleared partial ticket ${existingInc.ticketId} before clean chronological backfill`);
    }
    const token = await getGraphAccessToken();
    const userEmail = process.env.EMAIL_USER || 'support@edgestone.in';
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages?$filter=receivedDateTime ge 2026-11-21T02:30:00Z&$top=50&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,internetMessageId,internetMessageHeaders,body,hasAttachments&$orderby=receivedDateTime asc`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const msgs = (data.value || []).filter(m =>
        (m.subject || '').includes('INC000011767887') ||
        (m.body?.content || '').includes('INC000011767887')
    );

    console.log(`Found ${msgs.length} messages in Graph matching INC000011767887`);
    for (const msg of msgs) {
        const fromAddr = msg.from?.emailAddress?.address || '';
        const fromName = msg.from?.emailAddress?.name || fromAddr;
        const toRecips = (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean);
        const ccRecips = (msg.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean);
        const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
        const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;
        const attachments = await fetchMessageAttachments(msg.id, msg.hasAttachments, token, userEmail);

        console.log(`Ingesting: [${msg.receivedDateTime}] From: ${fromAddr} | Subj: "${msg.subject}"`);
        const result = await createTicketFromEmail({
            from: fromAddr,
            fromName,
            to: toRecips,
            cc: ccRecips,
            subject: msg.subject || '',
            body: msg.body?.content || '',
            html: msg.body?.contentType === 'html' ? msg.body?.content : null,
            date: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
            messageId: msg.internetMessageId,
            inReplyTo: inReplyToHeader,
            references: referencesHeader,
            attachments
        });
        console.log(`  -> Result ID: ${result?.ticketId || result?.id || 'null'}`);
    }

    console.log('\n=== 5. VERIFYING INC000011767887 TICKET IN DB ===');
    const incTicket = await prisma.ticket.findFirst({
        where: { header: { contains: 'INC000011767887', mode: 'insensitive' } },
        include: { vendor: true, replies: { orderBy: { createdAt: 'asc' } } }
    });
    if (incTicket) {
        console.log(`Created Ticket: ${incTicket.ticketId} (${incTicket.id}) | Type: ${incTicket.ticketType} | Status: ${incTicket.status} | Priority: ${incTicket.priority} | Vendor: ${incTicket.vendor?.name}`);
        console.log(`Replies count: ${incTicket.replies.length}`);
        for (const r of incTicket.replies) {
            console.log(`  - [${r.createdAt.toISOString()}] type=${r.type} cat=${r.category} author="${r.author}" sub="${r.subject}"`);
        }
    } else {
        console.log('ERROR: INC000011767887 ticket not found after backfill!');
    }
}

main()
    .catch(err => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
