const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();
const { findExistingTicketForReply } = require('../services/ticket/ticketThreadingService');
const VendorModel = require('../models/vendor');
const ClientModel = require('../models/client');

async function testIngestionTrace() {
  const emailData = {
    from: 'noc@neutrality.one',
    fromName: 'Neutrality NOC',
    subject: 'Re: Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request',
    body: 'Hi Team,\n\nThe link is stable since 3:19:37UTC and no further flap since last reported flap.\n\nBest Regards,\nNOC',
    date: '27 Oct 2026 06:03',
    messageId: '<LO4P123MB4557B9BAF25FD0DA79D6C478C3602@LO4P123MB4557.GBRP123.PROD.OUTLOOK.COM>',
    inReplyTo: undefined,
    references: undefined
  };

  console.log('1. findExistingTicketForReply...');
  const existingTicket = await findExistingTicketForReply(
    emailData.inReplyTo,
    emailData.references,
    emailData.subject,
    emailData.body,
    emailData.from
  );
  console.log('existingTicket:', existingTicket ? existingTicket.ticketId : 'null');

  // Let's check sender identification
  const clients = await ClientModel.findAllClients();
  const potentialClientIds = clients.filter(c => c.emails.some(e => e.toLowerCase() === emailData.from.toLowerCase())).map(c => c.id);
  console.log('potentialClientIds:', potentialClientIds);

  const vendors = await VendorModel.findAllVendors();
  const potentialVendorIds = vendors.filter(v => v.emails.some(e => e.toLowerCase() === emailData.from.toLowerCase())).map(v => v.id);
  console.log('potentialVendorIds:', potentialVendorIds);

  // Let's check circuits
  const allCircuits = await prisma.circuit.findMany({
    select: { id: true, customerCircuitId: true, supplierCircuitId: true, clientId: true, vendorId: true, isMultiVendor: true, vendorCircuits: true }
  });
  const matchedCircuit = allCircuits.find(c => c.customerCircuitId === 'N1/SG1-MUM/ESPL-007');
  console.log('matchedCircuit:', matchedCircuit);

  // Check lines 716-848 of ticketIngestionService:
  // Is ticketType Client or Vendor?
  console.log('Checking ticketType disambiguation...');
}

testIngestionTrace().catch(console.error).finally(() => prisma.$disconnect());
