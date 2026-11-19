# NEBU Control: Security blockers (test branch, 2026-11-18)

This is a code-review checklist, **not** a penetration-test certificate. Do not use real customer data in test until resolved.

## Confirmed code-level findings
1. **High: public inventory read** — `demo-orders.mjs` returns disabled product IDs for `action:'inventory'` without staff authentication. This may be intended for customers, but staff and public read APIs must be separated, with a narrow public response.
2. **High: customer status access relies on bearer token** — `action:'status'` checks `body.token === order.customerToken`. Tokens must never leak via logs, URLs, analytics or third-party scripts. Add token expiry/retention and avoid exposing unnecessary fields.
3. **High: staff authentication relies on shared static key** — `x-nebu-test-key` and `NEBU_TEST_ADMIN_KEY`. Before production use individual staff authentication/session management, rotation, revocation and rate limiting. Test sessions now renew silently every 30 min while the page is open, up to 12 h after code entry (stored only in the tab's sessionStorage); there is still no server-side revocation of a stolen token before it expires.
4. **High: order retention is not time-based** — test code stores up to 100 orders (`orders.slice(0,100)`), not a defined data deletion schedule. Build retention/deletion workflow and document lawful retention needs.
5. **Medium: non-atomic public rate limiter** — code itself notes its Blobs IP throttle is not production-ready. Add edge/WAF or transactional throttling for production.
6. **Medium: staff API returns complete orders** — GET returns all stored orders minus customerToken. Limit fields and scope by role; ensure no-store on responses.
7. **Medium: error handling** — avoid logging raw errors that might contain customer data or external service payloads; sanitize operational logs.
8. **Medium: request origin/CORS/CSRF and security headers** — verify exact deployment configuration, browser storage of admin key, CSP, cookie policy, and dependency vulnerabilities before launch.

## Required validation
- [ ] Unauthorized GET/POST, manipulated prices, malformed JSON and oversized body tested against deployed **test** endpoint.
- [ ] Public user cannot enumerate orders or retrieve customer data with guessed IDs.
- [ ] Test staff sessions expire and can be revoked.
- [ ] Customer status tokens are high entropy, scoped, expiring and not exposed in URLs/logs.
- [ ] Document Netlify/database/push-provider data processing, DPA/AVV, hosting regions, sub-processors and retention.
- [ ] Implement automated deletion/anonymization with exception for legally required records.
- [ ] Test backups, restore, incident response and credential rotation.
- [ ] Independent security review and GDPR legal review before real-customer launch.

## Release rule
No production write integration or real customer order handling until all high findings have been resolved and verified.
