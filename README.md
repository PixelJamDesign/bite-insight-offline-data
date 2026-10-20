# Bite Insight offline databases

Product databases the [Bite Insight](https://biteinsight.co.uk) app downloads so it can scan without a connection. There's one SQLite file per country.

They're published as release files. The app reads `manifest.json` from the latest release, then downloads the country it needs.

## Where the data comes from

Built from the [Open Food Facts](https://world.openfoodfacts.org) data export. Open Food Facts data is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/). These databases are derived from it and are shared under the same licence.

Product data © Open Food Facts contributors.

## Updating

Build with `scripts/build-offline-db.js` in the app repo, then create a new release here with every `.db` file and `manifest.json`, and mark it as the latest release.

## UK products for swaps

The app also suggests healthier swaps by supermarket. Those come from a table of UK products in the app's Supabase database, built from the same export by the scripts in `scripts/off-uk/`.

A GitHub Action (`.github/workflows/off-uk-sync.yml`) applies Open Food Facts' daily changes every night and does a full reload on the first Sunday of each month. It needs the `SUPABASE_SERVICE_ROLE_KEY` repository secret. To run it by hand, use "Run workflow" on the Actions tab.
