const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();
const { findExistingTicketForReply } = require('../services/ticket/ticketThreadingService');

async function test() {
  console.log('--- TEST 1: Agent sent email for Link Flapping ---');
  const t1 = await findExistingTicketForReply(
    null,
    null,
    "Re: Link Flapping || CKT ID : CAR12MUMSNG005533 || 27th OCT 2026 || ticket EN_IM_27102026_603516 ",
    "Hi team, We are following with our customer for the link status.",
    "support@edgestone.in"
  );
  console.log('Result 1:', t1 ? `${t1.ticketId} (${t1.header})` : 'null');

  console.log('\n--- TEST 2: Customer Neutrality email ---');
  const t2 = await findExistingTicketForReply(
    null,
    null,
    "Re: Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request",
    "Dear team, please check RFO",
    "noc@neutrality.one"
  );
  console.log('Result 2:', t2 ? `${t2.ticketId} (${t2.header})` : 'null');

  console.log('\n--- TEST 3: Vendor Vi Fault Update email ---');
  const t3 = await findExistingTicketForReply(
    null,
    null,
    "Fault Update EN_IM_27102026_603516-CAR12MUMSNG005533-EDGESTONE SINGAPORE PTE. LTD.-Link Flapping-EN_IM_27102026_603516",
    "Dear Customer, Vi Team would like to share with you the latest progress regarding the reported fault.",
    "flsupport.in@vodafoneidea.com"
  );
  console.log('Result 3:', t3 ? `${t3.ticketId} (${t3.header})` : 'null');
}

test().catch(console.error).finally(() => prisma.$disconnect());
