# SolidBunch WordPress core

Composer-compatible package repository for WordPress core distributions, maintained by [SolidBunch](https://solidbunch.com) for [StarterKit](https://starter-kit.io).\
Provides **two variants** of WordPress core packages:

- `solidbunch/wordpress-core` – full WordPress archive, identical to [wordpress.org](https://wordpress.org/download)
- `solidbunch/wordpress-core-no-content` – stripped-down archive without `wp-content/`, ideal for CI/CD or StarterKit use

---

## ✅ Usage

### Add repository

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
  "solidbunch/wordpress-core": "^6.8"
}
```

### Install minimal WordPress (no-content)

```json
"require": {
  "solidbunch/wordpress-core-no-content": "^6.8"
}
```

---

## 📆 About the Packages

| Package name                           | Contents         | Target use case              |
| -------------------------------------- | ---------------- | ---------------------------- |
| `solidbunch/wordpress-core`            | Full WP archive  | General usage, classic setup |
| `solidbunch/wordpress-core-no-content` | No `wp-content/` | DevOps, CI, custom themes    |

All packages include:

- Correct PHP version requirement (parsed from official WordPress metadata)
- `license: MIT`
- Optional `extra.mysql_version` field for advanced tooling

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

The `packages.json` is updated automatically using:

- Official WordPress API: `https://api.wordpress.org/core/version-check/1.7/`
- Node.js script `generate-packages-json.js` (included in this repository)
- Optional GitHub Actions trigger (e.g. daily schedule)

---

## 📝 License

MIT — for repository contents and generated metadata.\
Each WordPress archive remains under [GPLv2+](https://wordpress.org/about/license/).

