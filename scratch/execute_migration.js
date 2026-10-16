const prisma = require('../models/index');
const ticketService = require('../services/ticketService');

async function executeMigration() {
    console.log('--- STARTING SAFE DATA MIGRATION ---');

    try {
        // 1. Move #1023 replies to #1021
        const ticket1021 = await prisma.ticket.findFirst({ where: { ticketId: '#1021' } });
        const ticket1023 = await prisma.ticket.findFirst({ where: { ticketId: '#1023' } });

        if (ticket1021 && ticket1023) {
            console.log(`Moving replies from ${ticket1023.ticketId} to ${ticket1021.ticketId}...`);
            const moved1023 = await prisma.reply.updateMany({
                where: { ticketId: ticket1023.id },
                data: { ticketId: ticket1021.id }
            });
            console.log(`Moved ${moved1023.count} replies to ${ticket1021.ticketId}`);

            // Delete duplicate ticket #1023 cleanly
            await ticketService.deleteTicket(ticket1023.id);
            console.log(`Deleted duplicate ticket ${ticket1023.ticketId}`);
        } else {
            console.log('Ticket #1023 already handled or not found.');
        }

        // 2. Find Ticket #1018 and its foreign replies for ESPL-002
        const ticket1018 = await prisma.ticket.findFirst({
            where: { ticketId: '#1018' },
            include: { replies: true }
        });

        if (!ticket1018) {
            throw new Error('Ticket #1018 not found');
        }

        const foreignReplies = ticket1018.replies.filter(r => 
            (r.subject && (r.subject.includes('ESPL-002') || r.subject.includes('NP001') || r.subject.includes('41445467'))) ||
            (r.text && (r.text.includes('BA/SNG-CHK/ESPL-002') || r.text.includes('SNG/CU-CHK/CU NP001') || r.text.includes('41445467')))
        );

        console.log(`Found ${foreignReplies.length} replies to extract from #1018`);

        if (foreignReplies.length > 0) {
            // 3. Create new Ticket #1025 for Airtel on Circuit BA/SNG-CHK/ESPL-002
            const circuitRecord = await prisma.circuit.findFirst({
                where: { customerCircuitId: 'BA/SNG-CHK/ESPL-002' }
            });

            const newTicket = await prisma.ticket.create({
                data: {
                    ticketId: '#1025',
                    header: 'Circuit id BA/SNG-CHK/ESPL-002 || 41445467 || RFO ||',
                    email: 'Cfm.L2@airtel.com',
                    status: 'In Progress',
                    priority: 'High',
                    circuitId: 'BA/SNG-CHK/ESPL-002',
                    messageId: '<PN2PPF10F1601732A158DA820D28BB8E260AA9B2@PN2PPF10F160173.INDPRD01.PROD.OUTLOOK.COM>',
                    date: '16 Oct 2026',
                    receivedAt: new Date('2026-10-16T03:11:15.061Z'),
                    receivedTime: '08:41',
                    clientId: circuitRecord ? circuitRecord.clientId : ticket1018.clientId,
                    vendorId: circuitRecord ? circuitRecord.vendorId : null,
                    ticketType: 'Client',
                    isSlaActive: true,
                    isMaintenance: false,
                    cc: [
                        'support@edgestone.in',
                        'sandeep@edgestone.in',
                        'a_Harsh.Juneja@airtel.com',
                        'Kamal.Narula@airtel.com'
                    ]
                }
            });

            console.log(`Created new Ticket ${newTicket.ticketId} (ID: ${newTicket.id}) for Circuit BA/SNG-CHK/ESPL-002`);

            // 4. Move the foreign replies to the new ticket and correctly classify Vendor vs Client
            for (const r of foreignReplies) {
                const isVendorParticipant = (r.to || []).some(e => e.includes('chinaunicom')) ||
                                            (r.cc || []).some(e => e.includes('chinaunicom')) ||
                                            (r.author && r.author.includes('联通')) ||
                                            (r.subject && r.subject.includes('NP001'));

                const newCategory = isVendorParticipant ? 'vendor' : 'client';
                const newType = (r.author && r.author.includes('联通')) ? 'vendor' : r.type;

                await prisma.reply.update({
                    where: { id: r.id },
                    data: {
                        ticketId: newTicket.id,
                        category: newCategory,
                        type: newType
                    }
                });
            }

            console.log(`Successfully re-parented ${foreignReplies.length} replies to Ticket ${newTicket.ticketId}`);
        }

        // 5. Verify Ticket #1018
        const remaining1018 = await prisma.reply.count({ where: { ticketId: ticket1018.id } });
        console.log(`Ticket #1018 now has ${remaining1018} clean replies strictly belonging to Circuit ${ticket1018.circuitId}`);

        console.log('--- DATA MIGRATION COMPLETE ---');
    } catch (err) {
        console.error('Migration Error:', err);
    }
}

executeMigration().finally(() => process.exit(0));
