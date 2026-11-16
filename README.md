# Kitchen inventory

A plain HTML, CSS, and JavaScript interface backed by Express and MongoDB (`kitchen_app.ingredients`). The local server and Netlify Function share the same API.

## Run locally

```sh
npm ci
npm start
```

Open **http://localhost:3000/**. Keep the existing `.env` private. For a new checkout, copy `.env.example` to `.env` and privately configure `MONGODB_URI`, `DB_NAME=kitchen_app`, and `PORT=3000`. Node 24 is selected for deployment; Node 24 and 26 are supported locally.

## Use the inventory

- **Create:** complete the form and choose **Add ingredient**. A successful save resets the form and refreshes the list.
- **Read:** ingredients load on opening the page. **Refresh list** retries a failed read; existing cards remain visible while refreshing.
- **Edit:** choose **Edit** on a card. The existing form opens with its name, quantity, unit, storage, and optional expiry prefilled. Choose **Save changes** or **Cancel**. Clearing the expiry removes the saved date.
- **Delete:** choose **Delete** on a card. An inline confirmation names the ingredient; choose **Confirm delete** or **Cancel**. The card is removed only after the API confirms database success.

Saving, deleting, success, and error feedback is displayed. Conflicting actions and repeated submissions are blocked while a write is pending. Failed saves preserve all entered values and keep the form in Edit mode for retry. After an ambiguous connection failure, cancel and refresh before retrying to check the saved state.

The original styling and responsive layout are retained. Quantities and units are stored as entered; there is no unit conversion, name-based matching, or automatic merging. Updating uses only the selected ID and preserves extra stored fields.

## API

| Method and path | Behavior |
| --- | --- |
| `GET /api/ingredients` | Returns `count`, `limit: 100`, and ingredients sorted by name |
| `GET /api/ingredients?name=eggs` | Case-insensitive literal name search |
| `GET /api/ingredients?storage=fridge` | Storage filter; can be combined with name |
| `POST /api/ingredients` | Validates and inserts one record; returns HTTP 201 and the saved record |
| `PUT /api/ingredients/:id` | Validates and updates the selected record; returns HTTP 200 and the saved record |
| `DELETE /api/ingredients/:id` | Deletes the selected record; returns HTTP 204 with no body |

POST and PUT accept the same JSON body with `Content-Type: application/json`:

```json
{
  "name": "Tomatoes",
  "quantity": 2,
  "unit": "pieces",
  "storage": "fridge",
  "expiryDate": "2028-02-29"
}
```

Both routes require all fields except expiry. Names and units are trimmed; name accepts 1–100 characters and unit 1–40. Quantity must be a finite JSON number greater than zero. Storage must be `fridge`, `freezer`, or `pantry`. Expiry accepts a real `YYYY-MM-DD` date stored as a BSON Date at midnight UTC; omitted, null, or empty expiry is stored as null.

PUT uses `$set` for only these five fields and does not upsert, replace the document, or change its `_id`. Client-supplied extra fields are ignored. DELETE uses `deleteOne` with exactly the selected `_id`. IDs must be 24 hexadecimal characters. Invalid fields, IDs, malformed JSON, or oversized JSON return HTTP 400. A valid ID with no matching record returns HTTP 404. Unexpected database errors return action-specific HTTP 500 messages; credentials and driver details stay private.

## Verification

```sh
npm test
npm run build
npm run dev -- --offline --no-open
```

Netlify Dev serves **http://localhost:8888/** and loads `.env` without publishing. In another terminal:

```sh
npm run verify:api -- http://localhost:8888
```

The automated tests use fake collections and a DOM adapter running the real frontend script; they never access Atlas. They cover Create/Read behavior, shared POST/PUT validation, expiry Date/null handling, ObjectId validation, single-record writes, missing records, database failures, connection reuse, edit prefilling/cancel/retry, deletion confirmation/cancel/timing, duplicate prevention, and stale refresh protection.

The read-only `verify:api` script checks filters, repeated reads, invalid create input, malformed update/delete IDs, and rejection of deletion without an ID. It changes no records and expects the existing sample data to contain eggs and fridge ingredients.

Local verification on **November 15, 2026** used exactly one newly created disposable record, **DISPOSABLE CRUD TEST 2026-11-15**. The original Create form created it in Chrome. The real frontend script saved changes to all five fields through the local API; a real Chrome reload showed the saved name, quantity, unit, storage, and expiry, and Edit prefilled those saved values. A direct MongoDB read confirmed the expiry was a BSON Date.

The same disposable record was then edited through Netlify Dev to clear expiry and deleted through its actual Function/redirect path. Named confirmation, cancellation, repeated-submit prevention, removal after success, and absence after a fresh page load passed. A BSON-aware before/after comparison confirmed all **9 pre-existing documents remained unchanged**. The disposable record was removed. No pre-existing test/sample records were edited or deleted.

## Netlify deployment

The repository's `main` branch is connected to the existing Netlify site at https://coruscating-caramel-2abd72.netlify.app/. Pushing changes to `main` triggers deployment. Check the latest deployment's commit and published status before testing the live interface.

Existing settings are unchanged: build command `npm run build`, publish directory `public`, Functions directory `netlify/functions`, and `/api/*` redirects to the Express Function. Browser requests remain relative `/api/...` URLs. MongoDB connections are cached per process or warm Function instance. `.env` and `.netlify/` remain excluded from Git.

To deploy after review, commit the changes and push to the branch connected to the existing Netlify site. Keep `MONGODB_URI` and `DB_NAME=kitchen_app` in the Netlify Functions environment. Never upload `.env` or put database credentials in browser code. Local verification does not verify the hosted environment.

For live write verification, create a new clearly labelled disposable record, edit only that record, reload to confirm persistence, then delete only that record after checking its name. Compare the existing records before and after. Preserve every pre-existing record, including older sample and test records.
