# Bite Insight offline databases

Product databases the [Bite Insight](https://biteinsight.co.uk) app downloads so it can scan without a connection. There's one SQLite file per country.

They're published as release files. The app reads `manifest.json` from the latest release, then downloads the country it needs.

## Where the data comes from

Built from the [Open Food Facts](https://world.openfoodfacts.org) data export. Open Food Facts data is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/). These databases are derived from it and are shared under the same licence.

Product data © Open Food Facts contributors.

## Updating

A GitHub Action (`.github/workflows/offline-db.yml`) rebuilds the databases early on the 2nd of every month (05:23 UTC), after Open Food Facts has refreshed its export. It streams the export, builds one file per country with `scripts/offline-db/build-offline-db.js`, checks them, then publishes a release tagged `offline-db-vYYYY.MM.DD` and marks it as the latest. The app picks it up from there.

The scripts in `scripts/offline-db/` are the ones to change. The app repo used to have its own copy of the build script. It's now just a note pointing here, so don't build from it.

Only the publish step can write to this repo, and it only runs for a full build from `main` that passed every check. Each month the job also switches the schedules back on, because GitHub turns off scheduled workflows in a public repo after 60 days without a commit. If a month goes by with no new release, look at the Actions tab: a run that was skipped or failed shows there.

### Checks

`scripts/offline-db/check.js` runs after the build. If anything fails, the job stops, nothing is released and the app keeps the last good version. For each country it checks that:

- the file opens and passes SQLite's integrity check
- it has every column the app reads (allergens, traces and ingredient ids among them) and a version in its metadata
- the allergen data is really there: enough products have it, no product with ingredients is missing it, and some list an allergen (the May 2026 release had none at all)
- the "may contain" data is there too: some products list a trace
- the product count hasn't fallen more than 20% or doubled since the last release

It also checks that `manifest.json` lists every file with its real size and product count.

Before any of that, the build stops at the export's header row if a column it reads is missing. That's how the May 2026 release lost its allergens: the old script read a column the export doesn't have, so every row came out empty.

### Running it by hand

On the Actions tab, pick "Offline databases" and use "Run workflow".

- Leave "Dry run" ticked the first time. It builds and checks everything, then keeps the files as a workflow artifact for 5 days instead of making a release.
- Untick it to build and publish for real.
- The "Build one region only" box takes a code like `gb`, for a quick test of one country. It only works as a dry run, because a release has to include every country.

### Building on your own machine

```
cd scripts/offline-db
npm ci
node build-offline-db.js --region gb --limit 500 --out output
node check.js --dir output --regions gb --skip-count-compare
```

`--limit` stops each country after that many products, so only the start of the export is downloaded. Without it you get a full build, which streams the whole export (about 1.4 GB compressed). `--skip-count-compare` is for small test builds like this one, which would otherwise fail the comparison with the last release.

## UK products for swaps

The app also suggests healthier swaps by supermarket. Those come from a table of UK products in the app's Supabase database, built from the same export by the scripts in `scripts/off-uk/`.

A GitHub Action (`.github/workflows/off-uk-sync.yml`) applies Open Food Facts' daily changes every night and does a full reload on the first Sunday of each month. It needs the `SUPABASE_SERVICE_ROLE_KEY` repository secret. To run it by hand, use "Run workflow" on the Actions tab.
