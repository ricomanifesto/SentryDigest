# Reporting identity contracts

SentryDigest owns the canonical reporting-identity contract used to derive
stable source keys and item fragments across the Sentry product family.
Contract versions are immutable: never edit a released
`reporting-identity-v1.json` file or reuse its version number for new URL
semantics.

SentryDigest also owns the versioned, standard-library verifier at
`contracts/reporting-identity-verifier-v1.py`. Consumers vendor that file byte
for byte at the same path and use it to verify the verifier's canonical bytes
and the selected JSON contract. The verifier retries canonical fetches four
times with exponential backoff and bounded reads. Exit 2 means the canonical
artifact could not be verified; exit 3 means canonical bytes were fetched and
the local artifact drifted. Both conditions fail closed and carry distinct
Actions error annotations.

For a revision, add a new file such as `reporting-identity-v2.json` beside the
existing version, update the SentryDigest implementation and conformance tests,
and release the owner first while the prior version remains available. Then
vendor the new contract and its matching verifier byte for byte into
SentryInsight and GRCInsight, update each consumer implementation, test pin, and
workflow URL, and release the consumers.
Consumer CI rejects both a missing canonical copy and bytes that differ from the
selected version. Canonical-source unavailability and byte drift are distinct
operational failures and should be reported separately; both fail closed. Roll
back a consumer to its previous contract selection
rather than rewriting a released contract. Retire an old version only after no
consumer workflow references it and historical public artifacts remain
verifiable with their original semantics.

## Retained digest issues

A closed retained issue is an archive date older than the active UTC issue. Its
articles array is immutable: item count, field values, identities, and order
never change. The active UTC issue may continue accumulating that day's items
until a newer issue is published.

A closed issue may gain additive provenance only through an explicit schema
version bump with corresponding validation and rendering support. Historical
schemas remain readable under their released rules and never infer missing
provenance.

## Current family gate inventory

The current contract and verifier are enforced by these six consumer workflows:

- SentryInsight: `.github/workflows/validate.yml`
- SentryInsight: `.github/workflows/generate-report.yml`
- GRCInsight: `.github/workflows/ci.yml`
- GRCInsight: `.github/workflows/deploy-site.yml`
- GRCInsight: `.github/workflows/deploy-lambda.yml`
- GRCInsight: `.github/workflows/lambda-report-generation.yml`

Update this inventory in the owner repository whenever a consumer gate is added,
renamed, or retired.
