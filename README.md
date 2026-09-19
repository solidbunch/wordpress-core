# SolidBunch WordPress Core

A Composer-compatible repository of WordPress core distributions maintained by SolidBunch for the [StarterKit](https://starter-kit.io).

---

## 🧩 Available Packages

This repository provides two variants of the WordPress core:

- **`solidbunch/wordpress-core`** – full WordPress archive (identical to [wordpress.org](https://wordpress.org/download))
- **`solidbunch/wordpress-core-no-content`** – lightweight archive without `wp-content/`, ideal for CI/CD or StarterKit use

---

## ✅ Usage

### Add the repository to your `composer.json`

```json
"repositories": [
  {
    "type": "composer",
    "url": "https://solidbunch.github.io/wordpress-core"
  }
]
```

### Install full WordPress

```json
"require": {
  "solidbunch/wordpress-core": "^7.1"
}
```

### Install minimal WordPress (no-content)

```json
"require": {
  "solidbunch/wordpress-core-no-content": "^7.1"
}
```

### Pin an exact version

Any available version can be required exactly:

```json
"require": {
  "solidbunch/wordpress-core": "7.0.3"
}
```

### Available versions

Every stable WordPress release from the 4.1 branch onwards is kept and is never removed from the repository. The oldest available version is `4.1`; the newest is the latest WordPress release.

Branch releases are named exactly as WordPress names them (e.g. `7.1`, `6.9`, `4.1`). Composer treats these as `7.1.0`, `6.9.0` and `4.1.0`.

---

## 📆 About the Packages

| Package name                           | Contents         | Target use case              |
| -------------------------------------- | ---------------- | ---------------------------- |
| `solidbunch/wordpress-core`            | Full WP archive  | General usage, classic setup |
| `solidbunch/wordpress-core-no-content` | No `wp-content/` | DevOps, CI, custom themes    |

All packages include:

- `license: GPL-2.0-or-later`: the license of the WordPress archive itself (the scripts in this repository are MIT, see `LICENSE.md`)
- `require.php`: the PHP requirement of each release (`>=X.Y`), taken from the WordPress API or from the release's own `wp-includes/version.php`
- Optional `extra.mysql_version` field for advanced tooling
- `dist.shasum`: the SHA-1 of the release archive, taken from the `.sha1` file that wordpress.org publishes next to each archive (e.g. `https://downloads.wordpress.org/release/wordpress-7.1.zip.sha1`). Composer verifies it on download.

> ❗ Limit of the checksums: an entry that already has a valid checksum is never re-fetched. If WordPress ever re-publishes an archive under the same URL with a different checksum, this repository does not notice it.

---

## 🔧 Custom Install Paths with solidbunch/composer-installers

To control where the WordPress core is installed (e.g. `web/wp-core/` instead of `vendor/`), use the optional Composer plugin:

```bash
composer require solidbunch/composer-installers
```

Then add the installer path to your `composer.json`:

```json
"extra": {
  "installer-paths": {
    "web/wp-core/": [
      "type:wordpress-core"
    ]
  }
}
```

This plugin recognizes `type: wordpress-core` and places the archive into the specified directory.

> ❗ `solidbunch/composer-installers` is not required inside the WordPress core package itself. It should be used by the consuming project.

---

## ⚙ Automatic generation

The `packages.json` is kept up to date by the Node.js script `generate-packages-json.js` (included in this repository), which is run by GitHub Actions. The script `check-new-versions.js` decides whether the generator needs to run; it never modifies `packages.json` (it only writes its `run=` output for the workflow).

- `update-packages.yml` runs a light check about every 10 minutes (cron `3-59/10 * * * *`, deliberately off the hour). The check compares the versions offered by the WordPress `version-check` API with `packages.json` and starts the generator only when a new release whose archive is already published is missing. Once a day (cron `7 4 * * *`) it forces a full generator run, which also picks up versions that only `stable-check` lists. It can also be started manually (`workflow_dispatch`), which always forces a full generator run
- `keepalive.yml` makes a monthly heartbeat commit (1st of the month, 06:00 UTC)

The aim is to pick up a new release within 10–15 minutes, on a best-effort basis: GitHub documents that scheduled runs can be delayed under high load and that queued jobs may be dropped.

On every generator run:

- the generator merges into the existing `packages.json` and never removes a version
- it reads the official WordPress APIs `https://api.wordpress.org/core/version-check/1.7/` and `https://api.wordpress.org/core/stable-check/1.0/`, and adds every missing stable release from 4.1 onwards with its checksum
- it reads the PHP and MySQL requirements from the API or from the release's own `wp-includes/version.php`
- it validates the result before writing it and refuses to write on any violation
- the workflow commits only when `packages.json` changed
- the run fails, with nothing committed, if the WordPress API is unreachable or validation fails
- a version that could not be fully fetched is deferred: it is reported and picked up by the next run, while the rest is committed and the run then ends red

To check a local `packages.json` offline, run `node generate-packages-json.js --check` from the repository root. It validates the file and, inside a git checkout, reports versions that are missing compared with `HEAD`. It exits with code 1 on any violation and never writes anything. Running the generator without `--check` rewrites `packages.json` and calls the WordPress API.

---

## StarterKit Integration

### [Website](https://starter-kit.io) | [Documentation](https://starter-kit.io/docs/overview/)

See the [StarterKit installation guide](https://starter-kit.io/docs/installation/).

---

## Stay Connected

- Participate on [GitHub Discussions](https://github.com/solidbunch/starter-kit-foundation/discussions)
- Connect via [LinkedIn](https://www.linkedin.com/company/solidbunch)
