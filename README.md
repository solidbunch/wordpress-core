# SolidBunch WordPress core

Composer package that mirrors official WordPress releases as installable zip files.

This repository automatically generates and updates a `packages.json` file that can be used as a custom Composer repository to install specific WordPress core versions without themes or bundled plugins (uses `no-content.zip`).

## Features

- Automatically updated daily via GitHub Actions
- Uses `wordpress.org` official no-content archives
- Includes correct `php` version constraints from WordPress API
- Supports multiple versions in one unified Composer-compatible feed

## Usage in your `composer.json`

```json
{
  "repositories": [
    {
      "type": "composer",
      "url": "https://solidbunch.github.io/wordpress-core"
    }
  ],
  "require": {
    "solidbunch/wordpress-core": "^6.8"
  }
}