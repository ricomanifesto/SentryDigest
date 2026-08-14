# Reporting identity contracts

SentryDigest owns the canonical reporting-identity contract used to derive
stable source keys and item fragments across the Sentry product family.
Contract versions are immutable: never edit a released
`reporting-identity-v1.json` file or reuse its version number for new URL
semantics.

For a revision, add a new file such as `reporting-identity-v2.json` beside the
existing version, update the SentryDigest implementation and conformance tests,
and release the owner first while the prior version remains available. Then
vendor the new file byte for byte into SentryInsight and GRCInsight, update each
consumer implementation, test pin, and workflow URL, and release the consumers.
Consumer CI rejects both a missing canonical copy and bytes that differ from the
selected version. Canonical-source unavailability and byte drift are distinct
operational failures and should be reported separately; both fail closed. Roll
back a consumer to its previous contract selection
rather than rewriting a released contract. Retire an old version only after no
consumer workflow references it and historical public artifacts remain
verifiable with their original semantics.
