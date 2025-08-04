const fs = require('fs');
const https = require('https');

// Fetch latest WordPress version info
https.get('https://api.wordpress.org/core/version-check/1.7/', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);

  res.on('end', () => {
    try {
      const offers = JSON.parse(data).offers;
      const packagesByVersion = {};

      for (const offer of offers) {
        const version = offer.version;

        // Skip duplicate versions
        if (packagesByVersion[version]) continue;

        // Prefer no_content archive, fallback to full
        const pkg = offer.packages;
        const distUrl = pkg.no_content || pkg.full;

        if (!distUrl || typeof distUrl !== 'string') {
          console.warn(`⚠️ No valid archive for version ${version}, skipping.`);
          continue;
        }

        // Use PHP major.minor (e.g. 7.2.24 → 7.2)
        const phpVersionRaw = offer.php_version || '7.2';
        const phpMajorMinor = phpVersionRaw.split('.').slice(0, 2).join('.');
        const mysqlVersion = offer.mysql_version || null;

        packagesByVersion[version] = {
          name: 'solidbunch/wordpress-core',
          version: version,
          type: 'wordpress-core',
          require: {
            php: `>=${phpMajorMinor}`
          },
          dist: {
            type: 'zip',
            url: distUrl
          },
          ...(mysqlVersion && {
            extra: {
              mysql_version: mysqlVersion
            }
          })
        };
      }

      if (Object.keys(packagesByVersion).length === 0) {
        console.error('❌ No valid WordPress releases found.');
        process.exit(1);
      }

      const result = {
        packages: {
          'solidbunch/wordpress-core': packagesByVersion
        }
      };

      fs.writeFileSync('packages.json', JSON.stringify(result, null, 2));
      console.log(`✅ Generated packages.json with ${Object.keys(packagesByVersion).length} versions`);
    } catch (err) {
      console.error('❌ Failed to parse or write packages.json:', err);
      process.exit(1);
    }
  });
}).on('error', (err) => {
  console.error('❌ Failed to fetch WordPress version info:', err);
  process.exit(1);
});