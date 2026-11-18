# Kitchen inventory and shopping list

A plain HTML, CSS, and JavaScript interface backed by Express and MongoDB. Ingredients stay in `kitchen_app.ingredients`; shopping items use the separate `kitchen_app.shopping_items` collection. The local server and Netlify Function share the same API and cached database connection.

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

## Use the shopping list

Use the header links to switch between **My Kitchen** (`/`) and **Shopping List** (`/shopping.html`). Both pages use the same responsive styling, and the current page is highlighted.

- **Add:** enter a name, planned quantity, and any unit, then choose **Add shopping item**.
- **Edit:** choose **Edit** on an item, update the prefilled form, then **Save changes** or **Cancel**.
- **Delete:** choose **Delete**, check the named inline confirmation, then choose **Confirm delete** or **Cancel**.
- **Refresh:** saved changes remain after reloading. **Refresh list** retries a failed read without discarding visible items.

All three fields are required, and planned quantity must be a finite number greater than zero. The interface includes loading, empty, success, validation, and connection-error messages. Failed saves preserve entered values. Conflicting actions and repeated writes are disabled while a save or deletion is pending.

Each shopping item is stored separately, including items with matching names. Units are user-defined and never converted. Shopping actions do not purchase items or update the ingredient inventory. No migration, seeding, or replacement of existing records is needed.

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

### Shopping items

| Method and path | Behavior |
| --- | --- |
| `GET /api/shopping-items` | Returns `count` and `shoppingItems`, sorted by name and ID |
| `POST /api/shopping-items` | Validates and inserts a separate shopping item; returns HTTP 201 and the saved item |
| `PUT /api/shopping-items/:id` | Updates only the selected item; returns HTTP 200 and the saved item |
| `DELETE /api/shopping-items/:id` | Deletes only the selected item; returns HTTP 204 with no body |

POST and PUT accept the same JSON body:

```json
{
  "name": "Tomatoes",
  "plannedQuantity": 2.5,
  "unit": "bags"
}
```

Names and units are trimmed and accept 1–100 and 1–40 characters respectively. `plannedQuantity` must be a finite JSON number greater than zero. Only these three fields are written; extra fields are ignored. PUT uses `$set` without upserting or replacing documents. The same ObjectId, HTTP 400/404, request-size, and private-error handling rules apply. All shopping routes access only `shopping_items`.

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

Shopping List verification on **November 17, 2026** passed the build and all **27 existing tests**, with no new automated tests added. The local page rendered its navigation, form, and empty state. Real API checks created two disposable items with the same name and different custom units, edited one, and confirmed the saved values with a fresh read and the actual Netlify Function adapter. Invalid quantity, blank name, malformed IDs, and missing records returned the expected errors. Both disposable items were deleted by their exact IDs. A BSON-aware comparison confirmed all **5 ingredient records present at the start of this session were unchanged**, and the shopping collection was empty again. Browser automation was unreliable, so a complete browser interaction pass was not verified locally.

## Netlify deployment

The repository's `main` branch is connected to the existing Netlify site at https://coruscating-caramel-2abd72.netlify.app/. Pushing changes to `main` triggers deployment. Check the latest deployment's commit and published status before testing the live interface.

Existing settings are unchanged: build command `npm run build`, publish directory `public`, Functions directory `netlify/functions`, and `/api/*` redirects to the Express Function. Browser requests remain relative `/api/...` URLs. MongoDB connections are cached per process or warm Function instance. `.env` and `.netlify/` remain excluded from Git.

To deploy after review, commit the changes and push to the branch connected to the existing Netlify site. Keep `MONGODB_URI` and `DB_NAME=kitchen_app` in the Netlify Functions environment. Never upload `.env` or put database credentials in browser code. Local verification does not verify the hosted environment.

For live write verification, create a new clearly labelled disposable record, edit only that record, reload to confirm persistence, then delete only that record after checking its name. Compare the existing records before and after. Preserve every pre-existing record, including older sample and test records.
