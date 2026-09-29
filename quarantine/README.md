# QUARANTINED TESTS & LIVE SCRIPTS

## ⚠️ DANGER WARNING ⚠️
**DO NOT RUN THE SCRIPTS IN THIS DIRECTORY AGAINST PRODUCTION.**

The test suites and scripts in this directory were quarantined because they:
1. **Send real emails to live customer addresses**:
   - `ticket_flow.test.js.quarantine` queried the first ticket in the production database via `GET /api/tickets` and posted an automated reply (`E2E Reply <random_string>`). This sent live customer-facing emails to real ticket creators (e.g. `ambhore.sandeep1@gmail.com`).
   - `email_flow.test.js.quarantine` and SMTP test scripts sent live test emails directly to company and customer mailboxes.
2. **Pollute production data**:
   - `crud.test.js.quarantine` created live dummy records (`E2E Agent <suffix>`, `E2E Client <suffix>`, `E2E Vendor <suffix>`) via the live API on Railway, but attempted database cleanup locally, leaving orphaned dummy data on the production server.
   - Scripts in `manual_live_scripts/` created test circuits, clients, and vendors (`FLOW-CKT-*`, `ISOL-CUST-*`, `TEST-CIRC-*`) directly in the database.

---

## Directory Structure

```
quarantine/
├── README.md                              <- This documentation
├── e2e_tests/
│   ├── config.js
│   ├── helpers.js
│   └── suites/
│       ├── crud.test.js.quarantine        <- Created live Agents, Clients, Vendors
│       ├── email_flow.test.js.quarantine  <- Sent live SMTP emails
│       └── ticket_flow.test.js.quarantine <- Sent replies to real tickets
├── production_tests/
│   ├── auth.test.js.quarantine
│   ├── config.js
│   ├── error_handling.test.js.quarantine
│   ├── health.test.js.quarantine
│   ├── resource_structure.test.js.quarantine
│   └── resources.test.js.quarantine
└── manual_live_scripts/
    ├── send_test_email.js
    ├── test_all_4_ticketing_flows.js
    ├── test_audit_all_14_points.js
    ├── test_chg_015_018.js
    ├── test_client_added_cc_reply.js
    ├── test_client_circuit_isolation.js
    ├── test_email_flow.js
    ├── test_email_flow_with_delay.js
    ├── test_multi_vendor_threading.js
    ├── test_smtp.js
    ├── test_unknown_sender_circuit_protection.js
    ├── test_unregistered_vendor_maintenance.js
    ├── test_vendor_maintenance_subject.js
    └── test_zoho_reply.js
```

---

## How These Were Neutralized
1. All `.test.js` extensions were renamed to `.test.js.quarantine` so neither Jest nor IDE test runners will pick them up.
2. In `package.json`, Jest is explicitly configured with `testPathIgnorePatterns: ["/node_modules/", "/quarantine/"]` and restricted to `tests/auth`.
3. `test:e2e` and `test:prod` npm scripts have been blocked.
