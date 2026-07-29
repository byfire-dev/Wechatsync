# Publication contract

This package is the canonical publishable wire-contract boundary shared by
Wechatsync and VibeMarket. It contains no browser, platform I/O, persistence, or
UI code.

## Exports

- `@wechatsync/publication-contract/v2` freezes the existing Bridge v2 schemas.
  `@wechatsync/core/publication-inspection` re-exports this entry for backward
  compatibility.
- `@wechatsync/publication-contract/v3` defines the next strict protocol. It is
  exposed additively by the extension through `getPublicationBridgeInfoV3` and
  `inspectPublicationV3`; the Bridge v2 methods remain unchanged.

## V3 semantics

- Capability values are negotiation descriptors only. This first package slice
  defines the publication-inspection request/result wire schema, so producers
  can advertise only `publication_inspect` in a v3 descriptor. New values are
  added only together with their matching v3 command contracts and runtime
  handlers.
- A successful command returns one or more discriminated observations.
- Platform facts such as `REVIEW_REQUIRED`, `ACCOUNT_MISMATCH`,
  `LOGIN_REQUIRED`, `UNSUPPORTED`, `FETCH_ERROR`, and `PARSE_ERROR` remain
  observations so consumers can persist the evidence.
- An `ok: false` envelope is reserved for protocol, capability, transport,
  adapter-command, timeout, or unknown command failures.
- Platform capability descriptors carry both `contractVersion` and
  `adapterVersion`; consumers must still apply their own rollout allowlist.
- The extension derives descriptors from live registered inspectors. The
  current v3 surface is Zhihu, Sohu, and WeChat; Toutiao is not advertised.

Golden JSON fixtures under `fixtures/` are part of the compatibility contract.
Any producer or consumer implementation should parse the same fixtures in its
conformance suite before adopting v3.
