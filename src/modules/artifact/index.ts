/**
 * Public surface of `src/modules/artifact` (HT-116): the shared,
 * dependency-free verifier for module release artifacts — manifest
 * parsing/canonicalization/signature verification, safe tarball
 * extraction, and `module.config.json` validation. Consumed by the
 * `helpthread-module` CLI (`cli/`) today and by the engine's own
 * Connect/provisioning flow later (HT-119).
 */

export {
  MAX_ENTRY_COUNT,
  MAX_PATH_LENGTH,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  safeExtract,
  sha256Hex,
  UnsafeArchiveError,
} from './extract.js'
export {
  canonicalizeManifest,
  decodeBase64UrlStrict,
  MANIFEST_SCHEMA,
  ManifestParseError,
  type ManifestV1,
  parseManifest,
  verifyManifestSignature,
} from './manifest.js'

export {
  type EnvVarOwner,
  MODULE_CONFIG_SCHEMA_VERSION,
  type ModuleConfigEnvVar,
  ModuleConfigParseError,
  type ModuleConfigV1,
  parseModuleConfig,
} from './module-config.js'
