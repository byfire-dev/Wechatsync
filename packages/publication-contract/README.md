# Publication contract (Bridge v2)

This private workspace package freezes Wechatsync's legacy Bridge v2 schemas.
It contains no browser, platform I/O, persistence, or UI code.

`@wechatsync/core/publication-inspection` re-exports
`@wechatsync/publication-contract/v2` for backward compatibility. The root
entry point exposes the same v2 surface.

Bridge v3 has a separate cross-repository single source of truth:
`@byfire-dev/publication-bridge-contract`. Wechatsync must consume that package
directly and must not add v3 schemas, fixtures, or exports here.

The JSON files under `fixtures/v2/` are the frozen v2 compatibility fixtures.
The pack smoke test verifies the root and `/v2` ESM, CommonJS, type declaration,
and fixture exports.
