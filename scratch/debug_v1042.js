const ticketService = require('../services/ticketService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function debug() {
    const t = await prisma.ticket.findUnique({
        where: { ticketId: '#V1042' },
        include: { replies: true }
    });
    const rep = t.replies[0];
    console.log('Testing findExistingTicketForReply for #V1042 incoming email:');
    console.log('Subject:', rep.subject);
    console.log('Author:', rep.author);
    console.log('Message-ID:', rep.messageId);
    console.log('In-Reply-To:', rep.inReplyTo);
    console.log('References:', rep.references);

    const matched = await ticketService.findExistingTicketForReply(
        rep.inReplyTo,
        rep.references,
        rep.subject,
        rep.text,
        'gsoc-planned-event@pccwglobal.com'
    );
    console.log('Matched ticket:', matched ? matched.ticketId : 'null');
    await prisma.$disconnect();
}
debug();
