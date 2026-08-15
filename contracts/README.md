# Reporting Identity Contract

SentryDigest owns the shared rules that turn a source article URL into a stable report link. SentryInsight and GRCInsight use the same rules so a link created in one repository lands on the same article in another.

Two files make up version 1:

- `reporting-identity-v1.json` contains examples and expected results.
- `reporting-identity-verifier-v1.py` checks that each consumer has an exact copy of the released files.

## Rules for Released Versions

Released contract versions are immutable: do not edit `reporting-identity-v1.json` or reuse version 1 for different URL behavior. Historical reports must remain verifiable with the rules that created them.

The verifier retries canonical fetches four times with bounded reads. Its success result depends on the subcommand:

- `fetch` exits `0` when it retrieves and writes the canonical file. It does not inspect the local copy.
- `compare` exits `0` when the local and fetched canonical files match.
- Either subcommand exits `2` when the canonical file is unavailable or cannot be checked. Exit 2 means the canonical artifact could not be verified.
- `compare` exits `3` when the canonical file is available but the local copy differs. Exit 3 means canonical bytes were fetched and the local copy has byte drift.

Consumer CI rejects either failure code after running both subcommands. The codes remain separate so an unavailable source is not mistaken for contract drift.

## Releasing a New Version

1. Add a new file, such as `reporting-identity-v2.json`. Keep version 1 unchanged.
2. Update SentryDigest and its conformance tests.
3. Release the owner first: publish SentryDigest while the old version remains available.
4. Copy the new contract and matching verifier byte for byte into SentryInsight and GRCInsight.
5. Update each consumer's code, tests, and workflow URLs.
6. Retire an old version only after no workflow uses it and old public reports can still be checked.

If a consumer must roll back, point it to the previous version. Never rewrite a released contract.

## Retained Reports

A closed retained issue is a dated SentryDigest issue older than the active UTC date. Its articles array is immutable: item count, field values, identities, and order do not change. The active issue may keep collecting articles until the next date is published.

A closed issue may gain additive provenance only through an explicit schema version change with matching validation and rendering support. Older schemas stay readable under their original rules and never infer missing provenance.

The same rule applies to released SentryInsight report snapshots and GRCInsight dated publication pages: publish a new dated artifact or explicit schema version rather than rewriting historical evidence in place.

## Workflows That Enforce Version 1

- SentryInsight: `.github/workflows/validate.yml`
- SentryInsight: `.github/workflows/generate-report.yml`
- GRCInsight: `.github/workflows/ci.yml`
- GRCInsight: `.github/workflows/deploy-site.yml`
- GRCInsight: `.github/workflows/deploy-lambda.yml`
- GRCInsight: `.github/workflows/lambda-report-generation.yml`

Update this list when a consumer workflow is added, renamed, or removed.
