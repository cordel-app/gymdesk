# Payment page third-party script inventory

PCI DSS v4.0 Requirement 6.4.3: every third-party script on the payment page must be inventoried and integrity-checked.

| Script | URL | Purpose | Integrity | Added |
|---|---|---|---|---|
| monei.js | `https://js.monei.com/v3/monei.js` | Monei Card Input iframe + `confirmPayment` | **TBD** — obtain a versioned URL + `sha384` from Monei before production go-live | 2026-09-03 |

No other third-party scripts are loaded. Local scripts: `/js/utils.js`, `/js/checkout.js`.

Until Monei provides a stable SRI hash, do not treat this page as production-ready. Compensating control if no hash is available: a real-time page-integrity monitor (see #204).
