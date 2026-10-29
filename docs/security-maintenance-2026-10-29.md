# Security maintenance — 2026-10-29

Update the dependency lockfile to resolve form-data 4.0.5 to 4.0.6 and
compatible dependency patches. Run scheduled automation on Node.js 24.22.2
with reproducible `npm ci` installs. Notification routing, daily duplication,
and existing data-retention behavior are unchanged.

Validate with the offline notification and monitor suites, syntax checks, and
`npm audit`. Do not run the production daily-log entrypoint as a smoke test:
it creates external records and can send notifications.
