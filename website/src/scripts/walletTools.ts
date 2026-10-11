// Compatibility re-export. The implementation lives in src/swings/core/solanaTools.ts so that the Swings library does
// not depend on the UI-script layer (docs/architecture/MIGRATION_LOG.md, M-02). Existing importers keep working
// unchanged; new code in src/swings should import from `core/solanaTools` directly.
export * from '../swings/core/solanaTools.js';
