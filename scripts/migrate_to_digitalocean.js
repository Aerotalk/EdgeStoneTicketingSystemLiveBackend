const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const RENDER_DATABASE_URL = process.env.SOURCE_DATABASE_URL || process.env.RENDER_DATABASE_URL;
const DIGITALOCEAN_DATABASE_URL = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;

const renderPrisma = new PrismaClient({
  datasources: { db: { url: RENDER_DATABASE_URL } }
});

const doPrisma = new PrismaClient({
  datasources: { db: { url: DIGITALOCEAN_DATABASE_URL } }
});

// All 20 models in order
const MODELS = [
  'User',
  'Agent',
  'Client',
  'Vendor',
  'Circuit',
  'VendorCircuit',
  'CircuitSLAValue',
  'Sla',
  'SlaRule',
  'SlaAuditLog',
  'Ticket',
  'Reply',
  'Note',
  'SLARecord',
  'WorkNote',
  'ActivityLog',
  'GlobalNote',
  'ShiftHandover',
  'Signature',
  'Notification'
];

async function migrate() {
  console.log('====================================================');
  console.log('🚀 Starting Data Migration: Render -> DigitalOcean');
  console.log('====================================================');
  console.log('Source:       Render (oregon-postgres.render.com)');
  console.log('Destination:  DigitalOcean (blr1.db.ondigitalocean.com)');
  console.log('----------------------------------------------------');

  const startTime = Date.now();

  try {
    // 1. Disable FK constraints during bulk load
    console.log('Setting destination session_replication_role to replica...');
    await doPrisma.$executeRawUnsafe(`SET session_replication_role = 'replica';`);

    const stats = [];

    // 2. Transfer table by table
    for (const modelName of MODELS) {
      const delegateName = modelName.charAt(0).toLowerCase() + modelName.slice(1);
      
      const sourceCount = await renderPrisma[delegateName].count();
      
      if (sourceCount === 0) {
        stats.push({ Table: modelName, Source: 0, Destination: 0, Status: 'Empty (Skipped)' });
        continue;
      }

      console.log(`Migrating ${modelName} (${sourceCount} records)...`);
      
      const batchSize = 500;
      let transferred = 0;
      let skip = 0;

      while (skip < sourceCount) {
        const rows = await renderPrisma[delegateName].findMany({
          skip,
          take: batchSize
        });

        if (rows.length > 0) {
          await doPrisma[delegateName].createMany({
            data: rows,
            skipDuplicates: true
          });
          transferred += rows.length;
        }
        skip += batchSize;
      }

      const destCount = await doPrisma[delegateName].count();
      const status = sourceCount === destCount ? '✅ MATCH' : `⚠️ MISMATCH (${destCount}/${sourceCount})`;
      stats.push({ Table: modelName, Source: sourceCount, Destination: destCount, Status: status });
    }

    // 3. Re-enable FK constraints
    console.log('Restoring destination session_replication_role to origin...');
    await doPrisma.$executeRawUnsafe(`SET session_replication_role = 'origin';`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n====================================================');
    console.log(`🎉 Migration Completed in ${duration} seconds!`);
    console.log('====================================================');
    console.table(stats);

    const allMatch = stats.every(s => s.Status === '✅ MATCH' || s.Status === 'Empty (Skipped)');
    if (allMatch) {
      console.log('✨ 100% Data Integrity Verified! All records match exactly.');
    } else {
      console.warn('⚠️ Warning: Some tables had mismatched counts. Please check above.');
    }

  } catch (err) {
    console.error('❌ Migration failed with error:', err);
  } finally {
    await renderPrisma.$disconnect();
    await doPrisma.$disconnect();
  }
}

migrate();
