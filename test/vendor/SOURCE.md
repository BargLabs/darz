# Vendored schemas

`sarif-schema-2.1.0.json` is the SARIF 2.1.0 JSON schema (Errata 01, OASIS Standard), copied unmodified from:

https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json

SHA-256: `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e` (fetched 2026-11-20).

It is a JSON Schema draft-04 document, so the tests validate against it with `ajv-draft-04`. It is used by the tests only and is not shipped.
