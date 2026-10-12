# Bite Insight offline databases

Product databases the [Bite Insight](https://biteinsight.co.uk) app downloads so it can scan without a connection. There's one SQLite file per country.

They're published as release files. The app reads `manifest.json` from the latest release, then downloads the country it needs.

## Where the data comes from

Built from the [Open Food Facts](https://world.openfoodfacts.org) data export. Open Food Facts data is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/). These databases are derived from it and are shared under the same licence.

Product data © Open Food Facts contributors.

## Updating

Build with `scripts/build-offline-db.js` in the app repo, then create a new release here with every `.db` file and `manifest.json`, and mark it as the latest release.
