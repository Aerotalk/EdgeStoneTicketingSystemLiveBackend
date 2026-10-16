const prisma = require('../models/index');

async function previewCleanup() {
    console.log('=== 1. CHECK TICKET #1018 REPLIES TO MOVE ===');
    const ticket1018 = await prisma.ticket.findFirst({
        where: { ticketId: '#1018' },
        include: { replies: true }
    });

    const foreignReplies1018 = ticket1018.replies.filter(r => 
        (r.subject && (r.subject.includes('ESPL-002') || r.subject.includes('NP001') || r.subject.includes('41445467'))) ||
        (r.text && (r.text.includes('BA/SNG-CHK/ESPL-002') || r.text.includes('SNG/CU-CHK/CU NP001') || r.text.includes('41445467')))
    );

    console.log(`Found ${foreignReplies1018.length} replies in #1018 that belong to circuit BA/SNG-CHK/ESPL-002:`);
    foreignReplies1018.forEach((r, i) => {
        console.log(`  ${i + 1}. [${r.createdAt.toISOString()}] ${r.author} (${r.category}) -> ${r.subject}`);
    });

    console.log('\n=== 2. CHECK DUPLICATE TICKET #1023 ===');
    const ticket1023 = await prisma.ticket.findFirst({
        where: { ticketId: '#1023' },
        include: { replies: true }
    });

    if (ticket1023) {
        console.log(`Ticket #1023 has ${ticket1023.replies.length} replies to move into Ticket #1021:`);
        ticket1023.replies.forEach((r, i) => {
            console.log(`  ${i + 1}. [${r.createdAt.toISOString()}] ${r.author} (${r.category}) -> ${r.subject}`);
        });
    } else {
        console.log('Ticket #1023 not found.');
    }
}

previewCleanup().finally(() => process.exit(0));
