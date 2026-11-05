# Kitchen inventory — Read & Create

A plain HTML, CSS, and JavaScript interface for the class activity **Collecting Data From Users and Displaying It Back to Them**. Ingredients are read from and saved to `kitchen_app.ingredients` in MongoDB.

## Use the interface locally

Your existing `.env` is already configured. Keep it private and out of Git. No new packages are required for this interface.

```sh
cd ~/Desktop/kitchen-api
npm start
```

Open **http://localhost:3000/**. The page displays the ingredient list and an Add an ingredient form. Fill in the visible labels and press **Add ingredient**. While saving, the button is disabled. A successful save resets the form, shows confirmation, and refreshes the list. Reloading reads the same saved ingredient back from MongoDB.

Name, a positive numeric quantity, unit, and storage are required. Storage accepts fridge, freezer, or pantry. Expiry date is optional. Loading, empty, and error states appear in the list; **Refresh list** retries a failed read. Validation errors leave your entered form values intact.

For a fresh checkout, run `npm ci`, copy `.env.example` to `.env`, and replace its placeholders privately. Use `kitchen_app` for DB_NAME and `3000` for PORT. URL-encode reserved characters in database credentials. Node 24 is selected for deployment by `.node-version`; Node 24 and 26 are allowed locally.

## API

| Method and path | Behavior |
| --- | --- |
| `GET /api/ingredients` | Returns `count`, `limit: 100`, and ingredients sorted by name |
| `GET /api/ingredients?name=eggs` | Case-insensitive literal name search |
| `GET /api/ingredients?storage=fridge` | Storage filter; can be combined with name |
| `POST /api/ingredients` | Validates JSON, inserts one record, and returns HTTP 201 with that record |

Example POST body (Content-Type: application/json):

```json
{
  "name": "Tomatoes",
  "quantity": 2,
  "unit": "pieces",
  "storage": "fridge",
  "expiryDate": "2026-12-31"
}
```

Names and units are trimmed. Name accepts 1–100 characters and unit accepts 1–40. Quantity must be a finite JSON number greater than zero, not a numeric string. Expiry accepts a real `YYYY-MM-DD` date; it is converted to a MongoDB Date at midnight UTC. An omitted, empty, or null expiry is stored as null. Invalid input or JSON returns HTTP 400 with an `error` message. Unexpected database failures return a generic HTTP 500 response without credentials or internal driver details. Only the five ingredient fields are inserted; client-supplied `_id` and other extra fields are ignored.

No update, delete, authentication, recipes, or other features are included. On a public deployment, visitors can read and add ingredients through these routes.

## Files and routing

- `public/index.html`, `public/styles.css`, and `public/app.js`: responsive interface, accessible labels, relative `/api/...` fetch calls, and safe text rendering.
- `app.js`: shared Express GET and POST routes with server-side validation.
- `server.js`: local `.env` loading, connection startup, static file serving from `public/`, and API listening.
- `db.js`: one cached MongoClient connection promise per local process or warm Function instance. A failed initial attempt can be retried.
- `netlify/functions/api.js`: Express adapter using `serverless-http`; no listening port is opened inside a Function.
- `netlify.toml`: publishes `public/` and rewrites only `/api/*` to the Function. The old forced `/` rewrite was removed so Netlify serves `public/index.html` at the homepage.
- `.gitignore`: excludes `.env`, other local environment files, `node_modules/`, and `.netlify/`. The source directory `netlify/`, `netlify.toml`, and placeholder-only `.env.example` remain included.

This follows the [Netlify Express guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/). The Function continues using your existing server-side environment variables; database credentials are never sent to browser JavaScript.

## Test locally

```sh
npm test
npm run build
```

Tests use fake collections and a small DOM adapter, so they do not write to your database. They cover API filters and validation, JSON errors, Date/null handling, connection reuse and retry, loading/empty/error states, field rendering, disabled submit state, duplicate-submit prevention, form reset, success, and form errors.

To test Netlify routing locally:

```sh
npm run dev -- --offline --no-open
```

Open **http://localhost:8888/**. Netlify Dev reads local `.env`; offline mode avoids account linking and publishing while the API can still contact Atlas.

In another terminal:

```sh
npm run verify:api -- http://localhost:8888
```

This checks the three existing GET URLs, both filters, a repeat read, rejection of invalid create input, and rejection of DELETE. It does not create records. It expects the original sample data to include eggs and fridge ingredients.

The actual create verification for this update was **local**, using Netlify Dev and Atlas. Exactly one clearly labelled ingredient was added by the automated check: **TEST — Class activity (2026-11-05)**, quantity 1, unit test item, storage pantry, expiry 2026-12-31. The real frontend script was exercised with a DOM adapter against the actual API: HTTP 201, one POST despite a repeated submit, form reset, success, refreshed list, and persistence in a fresh page instance were verified. The browser displayed the real ingredient cards and a successful form save, and a real browser reload showed the labelled test ingredient. Browser automation was interrupted during form interaction, so the automated create check did not depend on browser controls.

The test ingredient was left in MongoDB. A direct database comparison confirmed all six original documents remained unchanged and the test expiry is stored as a BSON Date. Another record added during browser use was preserved too. Local `.env` was unchanged. This update has **not** been verified on the live Netlify deployment.

## Publish this update to your existing Netlify site

Your GitHub repository is already configured as `origin`: https://github.com/renyinxusheridan/kitchen-api.

1. Review the changes, then commit the interface, route, tests, and documentation:

```sh
git status --short
git add app.js server.js netlify.toml package.json public/index.html public/styles.css public/app.js scripts/verify-api.js test/api.test.js test/frontend.test.js test/frontend-harness.cjs README.md
git diff --cached --name-only
git commit -m "Add ingredient form and Read/Create API"
git push origin main
```

2. If your existing Netlify site is connected to this repository's main branch, the push starts a deployment. In **Deploys**, wait for it to finish. The existing settings remain: build command `npm run build`, publish directory `public`, Functions directory `netlify/functions`.
3. Confirm **Project configuration → Environment variables** has `MONGODB_URI` and `DB_NAME=kitchen_app` for the Production context and Functions scope (or All scopes if your plan does not offer scope controls). Do not add PORT or upload `.env`. If you change environment values, trigger a new deploy. See [Netlify Functions environment variables](https://docs.netlify.com/build/functions/environment-variables/).
4. Open your actual Netlify site at `/`, preferably in a private browser window, and confirm the form and list load. Also check the original API paths. If the project is private, use **Make public** or the project's visibility settings when you are ready for public access.
5. Run the safe read/validation check on your real hostname:

```sh
npm run verify:api -- https://YOUR-PROJECT.netlify.app
```

6. To verify live creating too, add a clearly labelled **LIVE TEST** ingredient through the deployed form and reload. A local result does not verify Netlify's hosted network or database permissions. No live write was performed during this implementation.

The local create succeeded, so the current local database user can insert ingredients. No Atlas changes were needed for local testing. If the deployed site uses different credentials or cannot reach Atlas, inspect the `api` Function logs before changing anything. A missing environment variable, bad credential, or network restriction requires a different fix. Keep any credential changes private and update both local and Netlify environment values when rotating a password.
