# Security deployment checklist

These changes require a Postgres database and new Vercel environment variables.
Do not deploy the code before completing the database and Stripe steps below.

## 1. Provision Postgres

Provision Neon Postgres through the Vercel Marketplace and connect it to this
project. Confirm that `DATABASE_URL` is available to Production and Preview.

Run the migration and initial metadata seed from a trusted environment:

```sh
pnpm install --frozen-lockfile
vercel env run -- pnpm db:migrate
vercel env run -- pnpm db:seed
```

Alternatively, export `DATABASE_URL` in the current shell before running the
two database commands. Standalone Node scripts do not automatically load
`.env.local`.

The seed only uses `products.json` quantities for new database rows. Re-running
the seed updates catalog metadata without resetting live inventory. It also
preserves products created through the admin dashboard; deactivate those
products from the dashboard when they should no longer appear in the store.

## 2. Configure secrets

Set these independently for Production and Preview:

- `SITE_URL`: exact HTTPS origin, with no path or trailing data.
- `DATABASE_URL`: provided by Neon.
- `STRIPE_SECRET_KEY`: Stripe secret key for that environment.
- `STRIPE_WEBHOOK_SECRET`: signing secret for the webhook below.
- `ADMIN_PASSWORD`: random password of at least 20 characters.
- `ADMIN_SESSION_SECRET`: independently generated random value of at least 32 characters.
- `RATE_LIMIT_SECRET`: a different random value of at least 32 characters.

Never copy production Stripe keys or the production database URL into Preview.

## 3. Configure Stripe

Create a webhook endpoint for:

```text
https://3dtransmissiontools.com/api/stripe-webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

Store the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`.

## 4. Validate before promotion

- Run `pnpm test`.
- Buy the last unit of a test product from two browsers; only one checkout may reserve it.
- Expire a test Checkout Session and confirm stock is restored exactly once.
- Replay a signed Stripe event and confirm stock does not change twice.
- Confirm the admin password never appears in session/local storage or request headers.
- Confirm a forged `Origin` or forwarding host cannot create a Checkout Session.
- Confirm the success page removes `session_id` from the address bar.

## Rollback warning

Do not roll back only the application code after the database becomes the
inventory authority. If a rollback is required, disable checkout first so the
static catalog and database cannot accept conflicting orders.

