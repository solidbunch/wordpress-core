# SolidBunch WordPress Core

A Composer-compatible repository of WordPress core distributions maintained by SolidBunch for the [StarterKit](https://starter-kit.io).

New WordPress releases are checked for **every 15 minutes**. A Cloudflare Worker cron starts the release check workflow, and the *Last release check* badge below shows how long ago the last successful check started.

<div align="center">

[![CI](https://github.com/solidbunch/wordpress-core/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/solidbunch/wordpress-core/actions/workflows/ci.yml)
[![WordPress release watch](https://github.com/solidbunch/wordpress-core/actions/workflows/update-packages.yml/badge.svg?branch=main)](https://github.com/solidbunch/wordpress-core/actions/workflows/update-packages.yml)
[![Weekly checksum audit](https://github.com/solidbunch/wordpress-core/actions/workflows/audit-checksums.yml/badge.svg?branch=main)](https://github.com/solidbunch/wordpress-core/actions/workflows/audit-checksums.yml)
[![Repository Keepalive](https://github.com/solidbunch/wordpress-core/actions/workflows/keepalive.yml/badge.svg?branch=main)](https://github.com/solidbunch/wordpress-core/actions/workflows/keepalive.yml)  
[![solidbunch/wordpress-core version](https://img.shields.io/endpoint?url=https%3A%2F%2Fsolidbunch.github.io%2Fwordpress-core%2Fbadges%2Fwordpress-core.json)](https://solidbunch.github.io/wordpress-core/status.json)
[![WordPress tracked](https://img.shields.io/endpoint?url=https%3A%2F%2Fsolidbunch.github.io%2Fwordpress-core%2Fbadges%2Fwordpress.json)](https://solidbunch.github.io/wordpress-core/status.json)
[![Last release check](https://img.shields.io/endpoint?url=https%3A%2F%2Fwordpress-core-release-watch.starter-kit.io%2Fbadge.json)](https://github.com/solidbunch/wordpress-core/actions/workflows/update-packages.yml)
[![wordpress.org to package](https://img.shields.io/endpoint?url=https%3A%2F%2Fsolidbunch.github.io%2Fwordpress-core%2Fbadges%2Fpickup-lag.json)](https://solidbunch.github.io/wordpress-core/status.json)
[![Pickup reaction](https://img.shields.io/endpoint?url=https%3A%2F%2Fsolidbunch.github.io%2Fwordpress-core%2Fbadges%2Freaction-lag.json)](https://solidbunch.github.io/wordpress-core/status.json)

</div>

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

### Automatic update PRs (Dependabot)

Since this package isn't on Packagist, Dependabot needs a `composer` ecosystem entry in your `.github/dependabot.yml` to see new versions — it resolves them from the `repositories` entry above, no extra config needed:

```yaml
updates:
  - package-ecosystem: "composer"
    directory: "/"
    schedule:
      interval: "weekly"
```

### Available versions

Every stable WordPress release from the 4.1 branch onwards is kept and is never removed from the repository. The oldest available version is `4.1`; the newest is the latest WordPress release.

Branch releases are named exactly as WordPress names them (e.g. `7.1`, `6.9`, `4.1`). Composer treats these as `7.1.0`, `6.9.0` and `4.1.0`.

#### Installing pre-releases

Pre-release versions (`X.Y-betaN`, `X.Y-RCN`, `X.Y.Z-RCN`) appear in `packages.json` only while WordPress is in a beta/RC window for that release. Once the window closes they are **not** removed — they stay available for anyone who already depends on them.

Composer's default `minimum-stability` is `stable`, which will not install these versions. To install one, either:

- Lower the project's minimum stability and keep preferring stable releases otherwise:
  ```json
  {
    "minimum-stability": "beta",
    "prefer-stable": true
  }
  ```
- Or require the specific pre-release with an explicit stability flag:
  ```json
  {
    "require": {
      "solidbunch/wordpress-core": "7.2.*@RC"
    }
  }
  ```

---

## 📆 About the Packages

| Package name                           | Contents         | Target use case              |
| -------------------------------------- | ---------------- | ---------------------------- |
| `solidbunch/wordpress-core`            | Full WP archive  | General usage, classic setup |
| `solidbunch/wordpress-core-no-content` | No `wp-content/` | DevOps, CI, custom themes    |

All packages include:

- `license: GPL-2.0-or-later`: the license of the WordPress archive itself (the scripts in this repository are MIT, see `LICENSE.md`)
- `require.php`: the PHP requirement of each release (`>=X.Y` or `>=X.Y.Z`, exactly as WordPress states it), taken from the WordPress API or from the release's own `wp-includes/version.php`
- Optional `extra.mysql_version` field for advanced tooling
- `dist.shasum`: the SHA-1 of the release archive, taken from the `.sha1` file that wordpress.org publishes next to each archive (e.g. `https://downloads.wordpress.org/release/wordpress-7.1.zip.sha1`). Composer verifies it on download.

---

## 🔧 Custom Install Paths with solidbunch/composer-installers

By default Composer installs the WordPress core into `vendor/`, no plugin needed. To control where it is installed (e.g. `web/wp-core/` instead of `vendor/`), use the optional Composer plugin (requires PHP ≥ 8.1):

```bash
composer require solidbunch/composer-installers
```

Composer 2.2+ only runs plugins listed in `allow-plugins`, so allow it (`composer require` asks interactively; in CI, add it yourself) and add the installer path to your `composer.json`:

```json
"config": {
  "allow-plugins": {
    "solidbunch/composer-installers": true
  }
},
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

## 🔁 Migrating from johnpbloch/wordpress-core

### Option A: keep your current installer (only the core package changes)

Installers key off the package `type` (`wordpress-core`), not the vendor. Your existing installer therefore keeps placing the core in `extra.wordpress-install-dir` after the package name changes. This was checked with a placeholder package of type `wordpress-core` for both `johnpbloch/wordpress-core-installer` and `roots/wordpress-core-installer`, and with the real `solidbunch/wordpress-core` 6.9.8 archive for `johnpbloch/wordpress-core-installer`. Option A applies to both installers.

The metapackage `johnpbloch/wordpress` requires the installer, so after you remove the metapackage the installer must be required explicitly.

Before (johnpbloch):

```json
{
  "require": {
    "johnpbloch/wordpress": "^6.9"
  },
  "extra": {
    "wordpress-install-dir": "web/wp-core"
  }
}
```

After (solidbunch, same installer):

```json
{
  "repositories": [
    {
      "type": "composer",
      "url": "https://solidbunch.github.io/wordpress-core"
    }
  ],
  "require": {
    "johnpbloch/wordpress-core-installer": "^2.0",
    "solidbunch/wordpress-core": "^6.9"
  },
  "extra": {
    "wordpress-install-dir": "web/wp-core"
  }
}
```

Since `solidbunch/composer-installers` 1.1.1 it can be installed next to another core installer without taking over: it claims `wordpress-core` only when `extra.installer-paths` has a rule that can match it (a `type:wordpress-core` rule, or any rule that is not a `type:` rule, such as an exact package name). Without such a rule your current installer keeps using `wordpress-install-dir`. A package-name rule makes it claim the whole `wordpress-core` type, so the other installer is no longer consulted for it. Pick one mechanism for placement.

### Option B: `installer-paths` with solidbunch/composer-installers

Before (johnpbloch):

```json
{
  "require": {
    "johnpbloch/wordpress": "^6.9"
  },
  "extra": {
    "wordpress-install-dir": "web/wp-core"
  }
}
```

After (solidbunch):

```json
{
  "repositories": [
    {
      "type": "composer",
      "url": "https://solidbunch.github.io/wordpress-core"
    }
  ],
  "require": {
    "solidbunch/wordpress-core": "^6.9",
    "solidbunch/composer-installers": "^1.1"
  },
  "extra": {
    "installer-paths": {
      "web/wp-core/": [
        "type:wordpress-core"
      ]
    }
  }
}
```

Remove `johnpbloch/wordpress` (or `johnpbloch/wordpress-core`) and `johnpbloch/wordpress-core-installer` from `require`. Add the repository entry above and `solidbunch/wordpress-core`.

### Installer swap

johnpbloch's installer places the archive using `extra.wordpress-install-dir`. With this repository, use [`solidbunch/composer-installers`](https://packagist.org/packages/solidbunch/composer-installers) and the `extra.installer-paths` convention to place it:

```json
"extra": {
  "installer-paths": {
    "web/wp-core/": [
      "type:wordpress-core"
    ]
  }
}
```

`solidbunch/composer-installers` understands two kinds of `installer-paths` rules: `type:<package-type>` (for example `type:wordpress-core`) and an exact package name (for example `solidbunch/wordpress-core-no-content`). Other forms, including `vendor:<name>` and the wildcard `type:*`, are not matched: the package then falls back to `vendor/`. `type:wordpress-core` is the recommended rule because it covers both variants.

---

## ⚙ Automatic generation

The `packages.json` is kept up to date by the Node.js script `generate-packages-json.js` (included in this repository), which is run by GitHub Actions. The script `check-new-versions.js` decides whether the generator needs to run; it never modifies `packages.json` (it only writes its `run=` output for the workflow). It queries both the stable and the beta channel (`?channel=beta`) of the WordPress `version-check` API; a beta-channel failure is reported (`BETA-CHANNEL-UNAVAILABLE`) and ignored rather than failing the check, since the beta channel is advisory only.

- `update-packages.yml` runs a light check. The check is started every 15 minutes by a Cloudflare Worker cron (`cloudflare-worker/`) that calls `workflow_dispatch` with `mode=light`. The check compares the versions offered by the WordPress `version-check` API with `packages.json` and starts the generator only when a new release whose archive is already published is missing. Once a day GitHub's own `schedule` (cron `7 4 * * *`) forces a full generator run, which also picks up versions that only `stable-check` lists and serves as a fallback if the Worker stops. It can also be started manually (`workflow_dispatch`), which forces a full generator run unless `mode` is `light`. If the `update` job fails, it opens a new GitHub issue or comments on the existing one; after a successful push, `packages.json` is attested with `actions/attest` — this is an audit trail for the file GitHub Actions produced, it does not prove the authenticity of the upstream WordPress archives themselves. A separate `publish` job is prepared to tag new versions in per-variant repositories for Packagist. It is inert until the `PUBLISH_REPO_*` repository variables and the `PUBLISH_TOKEN` secret are configured, and it never pushes to this repository or changes what GitHub Pages serves.
- `audit-checksums.yml` runs weekly (Monday 05:17 UTC) and re-checks the published `.sha1` of every entry already stored in `packages.json` against wordpress.org. It never overwrites anything; a mismatch fails the run and opens or comments on an issue.
- `ci.yml` runs `node --test` and `node generate-packages-json.js --check` on every pull request and on every push to `main`.
- `keepalive.yml` makes a monthly heartbeat commit (1st of the month, 06:00 UTC)
- `cloudflare-worker/` holds the Cloudflare Worker that triggers `update-packages.yml` every 15 minutes and serves `/badge.json`, a shields.io endpoint badge with the age of the last successful run of that workflow, measured from its `run_started_at` (green up to 30 minutes, yellow up to 2 hours, red beyond). To deploy it, from that directory run `npx wrangler secret put GITHUB_TOKEN` (a fine-grained token limited to this repository with `Actions: Read and write`) and then `npx wrangler deploy`.

All workflow steps that run a third-party action pin it to a commit SHA (not a floating tag); Dependabot proposes updates to those pins weekly.

Each generator run also writes `status.json` and the `badges/` directory alongside `packages.json` in the same commit, so the README badges above always reflect the same run.

Two of those badges measure latency, and they are deliberately separate because only one of them is about this repository:

- ***wordpress.org → package*** is how long the archive existed on wordpress.org before it landed here (`pickup.lagSeconds`). It is measured against the **newest** archive of the batch, and the message names the batch size when a run adds more than one version. wordpress.org builds a backport wave branch by branch over hours, newest branch first, so the highest version number in a wave is the first file built and its age is mostly that build queue — on 2026-09-22 the same release read as 2h 25m against `6.5.12` and 53m against `4.7.37`.
- ***pickup reaction*** is this repository's own share (`pickup.reactionSeconds`): the release was not visible at the previous release check, so it was published at most that long after it appeared. The `≤` is literal — the instant a release goes live on wordpress.org is not observable from outside, so this is an upper bound, and in normal operation it simply reflects the 15-minute check interval. It grows only when the check cadence itself breaks.

The release check runs every 15 minutes, started by the Cloudflare Worker. When the check finds a release with a published archive, the generator downloads and verifies each new archive before committing. After the commit, GitHub Pages rebuilds (typically 1–2 minutes) and serves `packages.json` through its CDN with `max-age=600`. Each run's job summary lists every version it added, with the archive's own `Last-Modified` time and the time the generator observed it, so the latency of every release can be read from the run.

On every generator run:

- the generator merges into the existing `packages.json` and never removes a version
- it reads the official WordPress APIs `https://api.wordpress.org/core/version-check/1.7/` and `https://api.wordpress.org/core/stable-check/1.0/`, and adds every missing stable release from 4.1 onwards with its checksum
- for each new version it downloads the archive and hashes it locally, comparing against the published `.sha1` (and the published `.md5`, when wordpress.org publishes one) rather than trusting the published checksum alone; a mismatch defers that version instead of writing it
- it reads the PHP and MySQL requirements from the API or from the release's own `wp-includes/version.php`
- it validates the result before writing it and refuses to write on any violation
- the workflow commits only when `packages.json` changed
- the run fails, with nothing committed, if the WordPress API is unreachable or validation fails
- a version that could not be fully fetched, or whose downloaded archive fails checksum verification, is deferred: it is reported and picked up by the next run, while the rest is committed and the run then ends red

To check a local `packages.json` offline, run `node generate-packages-json.js --check` from the repository root. It validates the file and, inside a git checkout, reports versions that are missing compared with `HEAD`. It exits with code 1 on any violation and never writes anything. Running the generator without `--check` rewrites `packages.json` and calls the WordPress API. `node generate-packages-json.js --backfill` rebuilds every entry from the data already in the file — no network access, deterministic and idempotent — for the rare case where a computed field's logic changes and existing entries need to be recomputed without re-fetching anything.

---

## StarterKit Integration

### [Website](https://starter-kit.io) | [Documentation](https://starter-kit.io/docs/overview/)

See the [StarterKit installation guide](https://starter-kit.io/docs/installation/).

---

## Stay Connected

- Participate on [GitHub Discussions](https://github.com/solidbunch/starter-kit-foundation/discussions)
- Connect via [LinkedIn](https://www.linkedin.com/company/solidbunch)
