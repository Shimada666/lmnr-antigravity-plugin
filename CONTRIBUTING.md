# Repository workflow

The owner authorized direct pushes to `main` for this plugin repository on 2026-10-20. A PR is not required here. This permission does not extend to other repositories.

Before committing, run `npm run check`, `npm run build`, `npm test`, and `agy plugin validate . --strict`. Commit both generated runtime bundles. Never commit credentials or real user transcripts. Keep failed deliveries visible; never blindly resend a request with an uncertain acknowledgement.
