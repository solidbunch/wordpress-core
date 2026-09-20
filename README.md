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

**Unverified**: wordpress.org may publish only the full release archive for a pre-release, and not a matching `-no-content` archive. If that happens, `solidbunch/wordpress-core-no-content` simply has no entry for that version — whether this asymmetry actually occurs for beta/RC releases has not been confirmed.

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

## 🔁 Migrating from johnpbloch/wordpress-core

### `composer.json` changes

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
    "solidbunch/composer-installers": "*"
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

Remove `johnpbloch/wordpress` (or `johnpbloch/wordpress-core`) and `johnpbloch/wordpress-core-installer` from `require`. Add the repository entry above (or, once this repository is published on Packagist, no `repositories` entry is needed) and `solidbunch/wordpress-core`.

### Installer swap

johnpbloch's installer places the archive using `extra.wordpress-install-dir`. This repository does not ship its own installer plugin; instead it relies on [`solidbunch/composer-installers`](https://packagist.org/packages/solidbunch/composer-installers) and the `extra.installer-paths` convention:

```json
"extra": {
  "installer-paths": {
    "web/wp-core/": [
      "type:wordpress-core"
    ]
  }
}
```

The `type:wordpress-core` rule is **required**, not optional. Composer's installer-paths mechanism calls `supports($packageType)` on the installer plugin, and that method only receives the package's `type` field — never its name or vendor. A rule based on `vendor:solidbunch` or `solidbunch/wordpress-core` alone would not work here; only `type:wordpress-core` (or a wildcard `type:*`) causes `solidbunch/composer-installers` to place the package.

### Honest limitations

- **`composer.lock` does not migrate automatically.** The version numbers published by this repository are identical to WordPress's own (e.g. `7.1.1`), but `johnpbloch/wordpress` and `solidbunch/wordpress-core` are different Composer package names. Composer has no way to infer that one replaces the other, so the old lock entry is simply removed and a new one is added for the new name — there is no in-place version bump.
- **Checksum re-fetch limit still applies**, as already noted above: an entry that already has a valid checksum is never re-fetched. This applies equally to a freshly migrated `composer.lock` entry once it is committed.
- **`provide: wordpress/core-implementation` makes core packages mutually exclusive.** Both `solidbunch/wordpress-core` and `solidbunch/wordpress-core-no-content` declare `provide: { "wordpress/core-implementation": "<version>" }`. If another package in the same project (e.g. `johnpbloch/wordpress` or a different core-implementation package) also declares this same virtual package, Composer will refuse to install both at once. This conflict is intentional: a project should have exactly one WordPress core implementation installed.

### Unverified

**Unverified**: which package names WordPress core's existing published security advisories are filed under (`composer audit` cross-references named packages) has not been confirmed. As a result, `composer audit` does not inherit any advisory history under `solidbunch/wordpress-core` or `solidbunch/wordpress-core-no-content` — migrating does not carry over any advisory coverage that may exist for `johnpbloch/*` or other package names.

---

## ⚙ Automatic generation

The `packages.json` is kept up to date by the Node.js script `generate-packages-json.js` (included in this repository), which is run by GitHub Actions. The script `check-new-versions.js` decides whether the generator needs to run; it never modifies `packages.json` (it only writes its `run=` output for the workflow).

- `update-packages.yml` runs a light check about every 10 minutes (cron `3-59/10 * * * *`, deliberately off the hour). The check compares the versions offered by the WordPress `version-check` API with `packages.json` and starts the generator only when a new release whose archive is already published is missing. Once a day (cron `7 4 * * *`) it forces a full generator run, which also picks up versions that only `stable-check` lists. It can also be started manually (`workflow_dispatch`), which always forces a full generator run
- `keepalive.yml` makes a monthly heartbeat commit (1st of the month, 06:00 UTC)

No end-to-end guarantee is made on how quickly a new release appears in `packages.json` for a client. GitHub documents `schedule` triggers as best-effort: the ~10-minute cron above can be delayed by tens of minutes under high load, and a queued run can be dropped entirely. When the check does run and finds a release with a published archive, the generator itself needs a few minutes to download and verify each new archive before committing. After the commit, GitHub Pages needs to rebuild (typically 1–2 minutes), and its CDN serves `packages.json` with `max-age=600`, so a client can keep seeing the previous file for up to 10 more minutes even after Pages has rebuilt. In practice a release usually shows up within tens of minutes, but any single step above can push that further out. Each run's job summary reports the measured lag (time from the archive's own publish timestamp to when it was added) for every version it adds, so actual latency is observable rather than assumed.

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
