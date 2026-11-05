# Kitchen API

A read-only Express API for `kitchen_app.ingredients`. The same routes run locally and through Netlify Functions. The response contains `count`, `limit` (100), and `ingredients`.

| Path | Result |
| --- | --- |
| `/api/ingredients` | Ingredients, sorted by name |
| `/api/ingredients?name=eggs` | Case-insensitive name search |
| `/api/ingredients?storage=fridge` | Exact storage filter |

You can combine the two filters. Storage accepts `fridge`, `freezer`, or `pantry`. The API has no create, update, or delete routes. Once the project is public, anyone with its URL can read the returned ingredient data.

## Run locally

The deployment uses Node.js **24**, selected by `.node-version`. Node 24 is an LTS release supported by Netlify Functions and satisfies the installed dependencies' Node requirements. Your current Node 26 can still run `npm start`. To use Node 24 on your Mac, install it from the [official Node.js download page](https://nodejs.org/en/download); if you already use a version manager, select Node 24 with it.

Your existing `.env` is already configured. Keep it. For a new checkout only, copy `.env.example` to `.env` and replace the URI placeholders privately. Special characters in the username/password must be URL-encoded. Never paste credentials into source code, GitHub, chat, or terminal commands.

```sh
cd ~/Desktop/kitchen-api
npm ci
npm start
```

Open `http://localhost:3000/api/ingredients`. Stop a server with Control+C in its terminal. If port 3000 is in use, stop the earlier server before starting another.

To test Netlify's local routing and Function adapter instead:

```sh
npm run dev -- --offline --no-open
```

Open `http://localhost:8888/api/ingredients`. Netlify Dev reads the local `.env`; its offline flag disables Netlify account/network features, while the API still contacts Atlas. No account login or public deployment is needed for this local test.

In another terminal:

```sh
npm run verify:api -- http://localhost:8888
```

The verification script calls all three endpoints, checks their records and filters, repeats a read, checks invalid storage, and confirms POST is rejected. It needs nonempty sample data matching eggs and fridge. It does not modify records.

## What changed for Netlify

- `app.js` contains the existing routes. It does not open a listening port or load `.env`.
- `server.js` loads `.env`, connects, and listens only for local `npm start`.
- `db.js` caches a MongoClient connection promise. Concurrent requests share the same attempt, and warm Function invocations reuse the pool. A failed connection is cleared so another invocation can retry. Separate Function instances each have their own pool, limited to five application connections per server plus driver monitoring sockets.
- `netlify/functions/api.js` adapts Express using `serverless-http` and keeps database sockets available after a response.
- `netlify.toml` rewrites `/api/*` to that Function, preserving the public API paths and query strings. `/` also returns the existing API welcome response. It configures esbuild and the Functions directory.
- `public/` is the empty static publish directory. Source code and `.env` are outside it. The nonempty build command checks syntax and makes Netlify build the Function, as required for an API without a frontend.
- `.gitignore` excludes `.env`, other local environment files, `node_modules/`, and `.netlify/`. `.env.example` contains placeholders only, with comments explaining the database and port values to enter.

This follows the [official Netlify Express guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/). Netlify's [runtime configuration](https://docs.netlify.com/build/functions/configuration/#nodejs-version-for-runtime) documents Node 24 support. MongoDB recommends [reusing a client and its connection pool](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/connection-pools/).

## Verification completed locally

Verified on November 5, 2026 with Node **24.22.2**, Netlify CLI **27.16.2**, and your actual Atlas records:

| Check | Result |
| --- | --- |
| `npm test` | 6 tests passed: adapter, validation, credential-safe errors, connection reuse, connection retry, and Function entrypoint |
| `netlify build --offline` | Production Function bundle built successfully |
| Standalone Express, port 3000 | All three endpoints returned HTTP 200; counts 6 / 1 / 3 |
| Netlify Dev rewrite + Function, port 8888 | All three endpoints returned HTTP 200; counts 6 / 1 / 3 |
| Repeat request, invalid storage, POST | Passed on both local servers |
| Function bundle and checked source | No current connection credentials or `.env` file in the Function bundle; no current credentials in checked source |
| Git ignore rules | Secret/local files excluded; `.env.example` allowed |

These are **local results**. They do not verify Netlify's hosted runtime or its network path to Atlas. No GitHub repository was created and no public deployment was made during preparation. Your MongoDB records were not modified.

## Step 1: Create your GitHub repository

1. Sign in to GitHub. Click **+ → New repository**.
2. Name it `kitchen-api`. A **Private** repository is fine; the deployed API can still be public.
3. Leave the README, `.gitignore`, and license initialization options unchecked because these files already exist locally. Click **Create repository**.
4. In your project terminal, run:

```sh
cd ~/Desktop/kitchen-api
git init -b main
git add .gitignore .env.example .node-version package.json package-lock.json server.js app.js db.js netlify.toml netlify/functions/api.js public/.gitkeep scripts/verify-api.js test/api.test.js README.md
git status --short
git diff --cached --name-only
```

5. Check the file list. `.env`, `node_modules`, and `.netlify` must be absent. `.env.example` should be present. Then commit:

```sh
git commit -m "Prepare read-only kitchen API for Netlify Functions"
```

If Git asks for your identity, set your own name and GitHub email using the instructions it displays, then repeat the commit. If this is your first GitHub push, use your IDE's GitHub sign-in or GitHub's supported authentication flow; never use the MongoDB password for GitHub.

6. Copy the HTTPS repository URL from GitHub. Replace `YOUR-USERNAME` below with your GitHub username:

```sh
git remote add origin https://github.com/YOUR-USERNAME/kitchen-api.git
git push -u origin main
```

7. Refresh the GitHub repository page. Confirm your source files are there and `.env` is absent.

## Step 2: Import the repository in Netlify

1. Sign in to Netlify and choose your team.
2. Click **Add new project → Import an existing project → GitHub**.
3. Follow the GitHub authorization screen and grant access to `kitchen-api`. Select that repository.
4. Use branch **main** and leave the base directory blank (the repository root).
5. Confirm the settings from `netlify.toml`: build command **npm run build**, publish directory **public**, and Functions directory **netlify/functions**. Choose no frontend framework if asked.
6. If the import screen lets you set environment variables, enter the two variables described below before publishing. Otherwise complete the import, then add them in the project settings and trigger a new deployment. A successful build without these variables does not mean database reads work.

Follow Netlify's [repository import guide](https://docs.netlify.com/start/quickstarts/deploy-from-repository/) for the current import flow.

## Step 3: Configure Functions environment variables

1. Open the Netlify project, then **Project configuration → Environment variables → Add a variable → Add a single variable**.
2. Add **MONGODB_URI**. Copy only its working value from your local `.env` into Netlify's value field. Omit the `MONGODB_URI=` prefix and any surrounding dotenv quotes. Mark it as a secret if that option is available.
3. Add **DB_NAME** with value **kitchen_app**.
4. For both variables, select the **Production** deploy context. If scope controls are available on your plan, include **Functions**. If only **All scopes** is available, use that. Builds-only scope will not work. Add values for Deploy Previews separately only if you want previews to access this database.
5. Do not add `PORT`: Functions do not listen on a port. Do not upload `.env` or put the URI in `netlify.toml`.
6. The committed `.node-version` selects Node 24 for builds, which Netlify uses for Functions by default. If the project's settings already contain `NODE_VERSION` or `AWS_LAMBDA_JS_RUNTIME` overrides, align them with `24` and `nodejs24.x` respectively. A runtime override belongs in Netlify's UI/CLI/API, never `netlify.toml`.
7. Go to **Deploys → Trigger deploy → Deploy project**. Environment changes require a fresh deployment.

Netlify documents [Functions scopes and redeployment](https://docs.netlify.com/build/functions/environment-variables/) and the [environment variable UI](https://docs.netlify.com/build/environment-variables/get-started/). The local `.env` is not transferred automatically by Git deployment.

## Step 4: Make the deployed API public and test it

1. Wait for a successful production deploy. In **Cloud compute → Functions**, confirm that the `api` Function exists. Its logs show credential-safe database error messages if a request fails.
2. If the project is private, use **Make public** after the first successful production deploy. Alternatively, go to **Project configuration → General → Visitor access → Project visibility** and set production deploys to public. GitHub repository privacy is a separate setting. See [Netlify project visibility](https://docs.netlify.com/manage/security/secure-access-to-sites/project-visibility/).
3. Copy the actual `https://…netlify.app` address from Netlify. Open these three paths on that address, ideally in a private/incognito browser window so you check unauthenticated access:

```text
https://YOUR-PROJECT.netlify.app/api/ingredients
https://YOUR-PROJECT.netlify.app/api/ingredients?name=eggs
https://YOUR-PROJECT.netlify.app/api/ingredients?storage=fridge
```

4. Run the same verification script against the real production origin:

```sh
npm run verify:api -- https://YOUR-PROJECT.netlify.app
```

With the current six records, expect 6 total, 1 eggs record, and 3 fridge records. Public verification is complete only when these live requests return the MongoDB JSON successfully. A Netlify login page is not an API response; check visibility if you see one. Share only the public URL or credential-safe errors for further diagnosis.

## If Atlas connection fails after deployment

The current local tests succeeded. There is no evidence requiring an Atlas change for your Mac, and there is not yet a hosted connection result. Keep the existing working database credentials.

- A missing-variable message means to fix **Netlify environment variables**, Functions scope, and deploy context, then redeploy.
- An authentication message means to check the privately entered URI, database username, password encoding, and environment context against the working local configuration.
- A DNS message means to check the Atlas hostname and DNS resolution.
- A server-selection failure means the deployed Function could not reach an eligible server. Check cluster availability and the Atlas network policy; the message alone does not prove the IP access list is the cause.

Netlify's default Function outbound IP addresses can change, and local testing uses your Mac's network. A home-IP-only Atlas entry does not grant access to Netlify's hosted Functions. See [Netlify outbound IP and Private Connectivity](https://docs.netlify.com/manage/security/private-connectivity/).

If hosted connection results establish that an Atlas IP entry is needed, open your **Atlas project → Security → Database & Network Access (or Network Access) → IP Access List → Add IP Address**. Add the known, approved Function egress IPs/CIDRs and confirm. **Add Current IP Address** adds your browser's network, not Netlify's hosted egress. Netlify Private Connectivity provides static Function egress addresses as an Enterprise add-on; with that enabled, allowlist all listed IPs for your Functions region. Ordinary Netlify Functions do not provide a single fixed IP you can copy from your site's public URL.

Allowing `0.0.0.0/0` admits database connection attempts from everywhere. It is a deliberate broader network policy, not a fix demonstrated by these local tests. Prefer approved static egress where available. Atlas documents [IP access entries and their implications](https://www.mongodb.com/docs/atlas/security/ip-access-list/). No Atlas network or database-user changes were performed during preparation.
