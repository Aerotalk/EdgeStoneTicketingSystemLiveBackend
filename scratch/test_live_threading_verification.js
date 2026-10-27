const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();
const { findExistingTicketForReply } = require('../services/ticket/ticketThreadingService');

async function verifyAll() {
  console.log('=== TEST 1: Agent sent email with Circuit CAR12MUMSNG005533 and Docket EN_IM_27102026_603516 ===');
  const t1 = await findExistingTicketForReply(
    null,
    null,
    "Re: Link Flapping || CKT ID : CAR12MUMSNG005533 || 27th OCT 2026 || ticket EN_IM_27102026_603516",
    "Hi team, We are following with our customer for the link status.",
    "support@edgestone.in"
  );
  console.log('Result 1 (Target: #1033, NOT #V1031):', t1 ? `${t1.ticketId} (${t1.header})` : 'null');

  console.log('\n=== TEST 2: Vendor Vi Fault Update for EN_IM_27102026_603516 ===');
  const t2 = await findExistingTicketForReply(
    null,
    null,
    "Fault Update EN_IM_27102026_603516-CAR12MUMSNG005533-EDGESTONE SINGAPORE PTE. LTD.-Link Flapping-EN_IM_27102026_603516",
    "Dear Customer, Vi Team would like to share with you the latest progress...",
    "flsupport.in@vodafoneidea.com"
  );
  console.log('Result 2 (Target: #1033, NOT #V1031):', t2 ? `${t2.ticketId} (${t2.header})` : 'null');

  console.log('\n=== TEST 3: Neutrality One reply with subject Neutrality.One#213768 ===');
  const t3 = await findExistingTicketForReply(
    null,
    null,
    "Re: Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request",
    "Hi Team, The link is stable since 3:19:37UTC and no further flap...",
    "noc@neutrality.one"
  );
  console.log('Result 3 (Target: #1033, NOT #V1031):', t3 ? `${t3.ticketId} (${t3.header})` : 'null');

  console.log('\n=== TEST 4: Airtel Maintenance CRQ update ===');
  const t4 = await findExistingTicketForReply(
    null,
    null,
    "RE: CRQ: “1100494638” Planned Maintenance activity, is scheduled on 19-OCT-2026 – Planned | Edgestone Singapore Pte Ltd",
    "Dear Team, We are checking with the provider...",
    "Changemgmt@airtel.com"
  );
  console.log('Result 4 (Target: #V1031):', t4 ? `${t4.ticketId} (${t4.header})` : 'null');

  console.log('\n=== TEST 5: Verify Ticket #V1031 current state ===');
  const v1031 = await prisma.ticket.findFirst({
    where: { ticketId: '#V1031' },
    include: { replies: true }
  });
  console.log(`Ticket #V1031 replies count: ${v1031.replies.length}`);
  const clientRepliesInV1031 = v1031.replies.filter(r => r.category === 'client' || r.type === 'client');
  console.log(`Client section in #V1031 empty? ${clientRepliesInV1031.length === 0 ? 'YES (100% Clean)' : 'NO'}`);

  console.log('\n=== TEST 6: Verify Ticket #1033 current state ===');
  const t1033 = await prisma.ticket.findFirst({
    where: { ticketId: '#1033' },
    include: { replies: true }
  });
  console.log(`Ticket #1033 total replies: ${t1033.replies.length}`);
  const clientReplies1033 = t1033.replies.filter(r => r.category === 'client');
  const vendorReplies1033 = t1033.replies.filter(r => r.category.startsWith('vendor'));
  console.log(`Ticket #1033 Client replies: ${clientReplies1033.length}`);
  console.log(`Ticket #1033 Vendor replies: ${vendorReplies1033.length}`);
}

verifyAll().catch(console.error).finally(() => prisma.$disconnect());
