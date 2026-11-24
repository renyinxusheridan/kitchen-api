# Kitchen inventory and grocery workflow

Plain HTML/CSS/JavaScript, Express and MongoDB, using the existing shared kitchen dataset. Categories, storage locations and confirmed ingredient aliases are shared. Unit preferences, the last-used storage and the selected navigation tab are browser-specific localStorage settings. There is no new account/ownership model.

Production uses the existing Vercel project at **https://kitchen-api-ten.vercel.app/**. Keep Vercel-only release commits marked `[skip netlify]` so the connected Netlify site does not deploy them. Database migrations are explicit operations, separate from deployment.

## Local development and verification

```sh
npm ci
npm run preview:workflow
```

Open **http://localhost:3230/__review** for isolated phone/tablet/desktop viewports, or **http://localhost:3230/** for the app. This fixture server never reads `.env` or connects to Atlas; all writes are in memory and reset when the process restarts. Fixtures include yesterday/today/+1/+3/+4/no-expiry stock, a stale Egg link, different units and ambiguous Tomatoes. The preview's `/__snapshot` and failure-injection endpoints exist only in this local fixture process, not in the deployed API.

```sh
npm run build
npm test
npm run verify:workflow
```

The build checks JavaScript syntax. Unit/API tests use isolated fake collections and the existing frontend DOM adapter. `verify:workflow` uses the privately configured Atlas connection **only with a uniquely named disposable database** (`kitchen_workflow_check_<timestamp>`), performs real transaction/write checks, then drops only that database. It never uses `kitchen_app`. The older `verify:categories` script likewise uses its own disposable database; `verify:api` is read-only.

For a real development database, privately configure `MONGODB_URI`, `DB_NAME` and optionally `PORT` in an ignored `.env`, then use `npm start` at http://localhost:3000/. This connects to the configured database, unlike the memory-only preview. Node 24 and 26 are supported. Never commit `.env`, credentials or `.netlify/`.

## Vercel deployment

The existing Vercel project deploys `main` using the Express preset in `vercel.json`. `app.js` exports the Express HTTP handler while retaining `createApp` for local development and API tests. An explicit `/` route serves `public/index.html`, and Vercel serves the remaining `public/` assets from its CDN. API requests retain their existing `/api/ingredients`, `/api/shopping-items`, and `/api/categories` paths.

Configure `MONGODB_URI` and `DB_NAME` in the Vercel project environment, then redeploy after environment changes. The database connection remains lazy and cached across warm requests. Deployment does not run migrations or modify existing records. Never commit `.env`, credentials, or local `.vercel/` files.

For a Vercel-only Git push, include `[skip netlify]` in the commit message to prevent the connected Netlify site from deploying that push.

## My Kitchen and Compare

My Kitchen and Shopping List are separate full-width views. The active tab is remembered in this browser. Compare stacks panels on phones with a 20px gap and independent list scrolling; panels sit side by side from 700px. Headers and rounded boundaries stay visible.

Outside Compare, filters are independent. Entering Compare copies the active view's category to both panels. Changing either category selector immediately updates both lists using a shared Compare value, including All categories and Uncategorized. Exiting restores the separate view filters. Deleted categories reset affected filters to All categories.

Stock is sorted by the earliest dated batch with remaining quantity, ascending (expired first); undated stock follows. This ordering applies to All categories, individual categories, combined API filters, and Compare. Expiry badges use the user's **local calendar day**, rather than elapsed 24-hour intervals: today and 1–3 days away are amber, past dates are red, with readable text. Later dates use the normal date label. Undated stock stays undated. Indicators refresh at the next local midnight and on focus/visibility return; there is no seconds-based timer.

Cards retain Add to list and a More actions menu. Stock details expand into individual batches with quantity, exact unit, location, expiry, Edit batch and Remove batch. The ingredient editor chooses the appropriate batch when multiple batches exist. Removing one batch never removes other batches or the ingredient identity. Whole-ingredient deletion still uses a named confirmation.

## Shopping checklist and one purchase review

Add unplanned items with Add; edit planned quantities with the quick action; use More actions for full editing/removal. Removing a shopping item never changes inventory. Checking a box means **Picked up**, not recorded stock. It persists through the API and can be unchecked until recording succeeds. Picked-up and recorded cards look different; recorded boxes are checked and disabled.

**To My Kitchen (N)** always counts every picked-up, unrecorded item across all categories, including hidden items. One review sheet includes them all; unpicked items remain on the list. Purchased quantities/units and available package-size details start from the plan and can differ from it. Each row shows a short match summary and optional Details & match controls. Storage for all items can be applied with one action. Expiry always starts blank for a new purchase, including purchases into an existing ingredient. Unassigned storage is valid.

Matching is rechecked against current inventory in this order:

1. Existing valid ingredientId.
2. Previously confirmed alias.
3. Unique exact match after case/whitespace normalization.
4. Unique conservative singular/plural match using an explicit food-word vocabulary (for example Egg/Eggs).

Display names are preserved; normalization is only for matching. The app never strips arbitrary final letters, translates names, or merges merely similar foods. Missing old links are rechecked rather than treated as permanent failures. Ambiguous matches require choosing a suggested record or Keep separate. Details also permits explicitly choosing any existing ingredient. Explicitly confirmed names can be remembered as shared MongoDB aliases; the checkbox is visible when confirming a match. Unknown plurals outside the conservative vocabulary remain separate until explicitly matched.

New items default to their shopping category and available shopping/last-used storage. Existing matches initially use their inventory category/location. Existing ingredient categories are preserved on recording. Every purchase appends a new batch, retaining older stock. Optional package-size details distinguish known sizes such as 500 g and 1 kg; no size is inferred. Quantities are summarized **only for exactly matching unit strings and package-size labels**; incompatible units/package sizes remain separately labelled. There is no unit conversion and no automatic copying of an older expiry date.

One confirmation saves the review. Each item is an independent MongoDB transaction: inventory/batch save, optional alias confirmation and shopping completion commit together. The shopping item's ID is the durable idempotency key. Double-clicks, concurrent requests, lost responses and refresh/retry cannot add that purchase again. Successful rows leave the review; failed rows keep their values and error feedback for retry. A network error can leave an outcome temporarily unknown, but retry remains safe. Concurrent automatic matching is serialized so two fresh purchases do not accidentally create duplicate identities.

## Settings

Units, Categories and Storage locations are equal green headings in the same scrollable sheet/dialog, with the Settings header and close button visible. Categories and locations use the same inline rename/delete pattern, with feedback beside the relevant record. Drafts in other sections remain intact. Escape cancels a focused inline rename/confirmation before closing the dialog, and focus returns to the appropriate row or Settings trigger.

Units include pieces, bags, packs, bottles, cartons, bunches, g, kg, mL and L, plus reusable custom units. An explicit default wins for new entries, otherwise the last-used unit, otherwise pieces. Legacy units remain available while editing. Removing a unit preference never edits saved stock.

Category names and storage names are trimmed, must have 1–100 characters and are unique regardless of capitalization. Built-in Uncategorized (`categoryId: null`) and Unassigned (`storageId: null`) cannot be edited/deleted. Renaming updates the displayed name without rewriting item assignments. Deletion previews the name and usage; confirmation rechecks usage inside a transaction, clears references and removes only the category/location. A stale preview returns 409 for fresh review. Assignment writes serialize against reference deletion to prevent broken references.

## Data model and migration

Existing collections/routes remain. `ingredients` keeps the same `_id` and display name and now has authoritative `batches`:

```js
{
  _id, name, categoryId,
  batches: [{ _id, quantity, unit, packageSize, storageId, expiryDate,
              sourceShoppingItemId, purchasedAt }],
  stockVersion: 1
}
```

The original migrated batch retains its original quantity, exact unit, expiry and location. Purchase-only fields are optional on older batches. Existing legacy fields remain saved for preservation, but once batches exist, stock reads/edits use the batches. API responses add `totals`, the earliest remaining `expiryDate`, and readable location/category names. Top-level quantity/unit/packageSize are a compatibility projection for the earliest batch's unit and package size; use `totals`/`batches` for all units. Empty identities report no stock and no invented expiry.

`shopping_items` adds `pickedUp` separately from the existing completion status. Recording stores the actual purchase and batch ID while preserving the planned quantity/unit. `storage_locations` stores stable `_id`, name, case-insensitive nameKey and revision. `ingredient_aliases` maps normalized confirmed names to ingredient IDs. `_workflow_locks` serializes automatic identity matching; it is not a user record.

The migration defaults to a **read-only preview**:

```sh
npm run migrate:workflow
```

For an explicitly chosen development/production database, after reviewing/backup, apply with:

```sh
npm run migrate:workflow -- --apply
```

Use the existing `migrate:categories` for an older checkout that has not yet migrated category references. Run migrations before using the new UI against that database. No migration runs automatically on startup or deployment.

The workflow migration seeds Fridge, Freezer and Pantry without duplicate names, preserves existing assignments (including hand-entered legacy locations), adds one original batch per legacy ingredient and adds false pickedUp only where missing. It never replaces a document, deletes food, changes original quantities/dates, or changes purchase status. Existing batches/references are not overwritten. The transaction and migration marker make reruns safe and prevent deleted seeded locations from being resurrected. Legacy records remain readable as virtual original batches during transition; an inventory edit/purchase materializes batches for that identity.

## API

All paths use the existing relative `/api` convention. IDs are MongoDB ObjectId strings; categoryId/storageId accept null fallbacks. Mutations validate server-side. APIs are shared and uncached. Errors return readable 400/404/409 or sanitized 500 responses; request JSON is bounded at 128 KB.

| Method and path | Behavior |
| --- | --- |
| `GET /api/ingredients` | All inventory with batches/totals, sorted by earliest remaining expiry |
| `GET /api/ingredients?categoryId=:id&name=eggs&storageId=:id` | Combined server-side filters; `null` selects a fallback |
| `POST /api/ingredients` | Name, positive quantity, unit, optional categoryId/storageId/expiryDate/packageSize; creates identity + batch |
| `PUT /api/ingredients/:id` | Edits identity name/category and one batch; `batchId` required when multiple batches exist |
| `DELETE /api/ingredients/:id/batches/:batchId` | Removes only that stock batch; returns refreshed ingredient |
| `DELETE /api/ingredients/:id` | Deletes only that whole identity, with UI confirmation |
| `GET /api/shopping-items?categoryId=:id` | Planned/recorded items and a global pickedUpCount |
| `GET /api/shopping-items?ingredientId=:id` | Unrecorded linked/normalized matching items for duplicate prevention |
| `POST /api/shopping-items` | Name, plannedQuantity, unit, optional categoryId/storageId/ingredientId/packageSize |
| `PUT /api/shopping-items/:id` | Edits the plan; preserves completion, picking and omitted reference fields |
| `PATCH /api/shopping-items/:id/picked-up` | `{ pickedUp: true/false }`; completed items cannot be unchecked |
| `DELETE /api/shopping-items/:id` | Removes the plan only, leaving inventory intact |
| `GET /api/shopping-items/review` | All picked-up/unrecorded rows and current match candidates, ignoring category filters |
| `POST /api/shopping-items/transfer` | `{ items: [...] }`; at most 100 unique rows per request, per-row results |
| `GET/POST /api/categories` | List/create shared categories |
| `GET/PUT/DELETE /api/categories/:id` | Usage preview/rename/confirmed transactional deletion |
| `GET/POST /api/storage-locations` | List/create shared storage locations |
| `GET/PUT/DELETE /api/storage-locations/:id` | Usage preview/rename/confirmed transactional deletion |

Transfer rows contain shoppingItemId, actual quantity/unit, storageId, optional categoryId/expiryDate/packageSize, and `matchMode`: `auto`, `selected` (with matchId and optional rememberAlias), or `separate`. The UI chunks large reviews into 25-row requests under one confirmation. Results identify successes, alreadyCompleted retries, and failures; HTTP 200 can contain a partial failure, so inspect each result.

Legacy `category=protein/grains/fruits_vegetables/other` and `storage=fridge/freezer/pantry` are accepted as aliases. The former `POST /api/shopping-items/:id/purchase` remains available for older clients using destination new/existing; it now appends a batch rather than replacing an older expiry/location. New UI purchases use bulk review and never require a destination dropdown.

## Verification for this update

The local build and **47 tests** pass. Tests cover migration preservation/reruns, location management/deletion rollback, category and combined filters, required expiry states and ordering, daylight-saving calendar boundaries, checklist persistence and removal, hidden selection counts, stale links, Egg/Eggs/aliases/ambiguity, different expiry/unit batches, targeted batch editing/removal, concurrent/repeated submissions, completion failure rollback and retry.

Real MongoDB checks in the disposable workflow database passed migration/rerun preservation, location create/rename/duplicate rejection/deletion, hidden picked-up selection, actual persisted batches with differing units/dates, confirmed aliases, concurrent idempotency, injected completion failure rollback, partial retry, batch editing/removal and fresh-read persistence. The disposable database was removed.

Safari browser checks used the isolated fixture server at 320×568, 390×844, 768×1024 and 1280×800. They covered category synchronization from either panel (including All/Uncategorized and active-view entry), expiry labels/order in Compare, picking/unchecking, unplanned Add and Remove, hidden-category review, corrected quantities, shared storage, ambiguous one-tap matching and visible alias confirmation, location creation/rename/assigned deletion, batch editing/removal, reload persistence and partial-failure retry with the failed row retaining 3.25. The final narrow-phone Compare layout provides 110px independently scrolling stock windows with a 20px gap; controls measured at least 44px, inputs at least 16px, with no horizontal overflow. Very short phones temporarily hide the single-view switch inside Compare; Exit Compare remains visible and restores it. Tablet and desktop panels remain side by side and the review is a centered dialog.

The production workflow migration was applied after a private backup of the affected collections. It retained the original fields of all five ingredients and both shopping items, added their stock batches/storage references/checklist state, and seeded three storage locations. A second run changed zero records. Backup files and credentials remain outside Git.

Physical-device software keyboards were not tested. Package sizes must be supplied when known and are never inferred or converted; unknown plurals outside the conservative vocabulary require an explicit match/alias.
