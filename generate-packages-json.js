const fs = require('fs');
const https = require('https');

// Fetch latest WordPress version info
https.get('https://api.wordpress.org/core/version-check/1.7/', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);

  res.on('end', () => {
    try {
      const offers = JSON.parse(data).offers;
      const noContentPackages = {};
      const fullPackages = {};

      for (const offer of offers) {
        const version = offer.version;

        // Skip duplicate versions
        if (noContentPackages[version] || fullPackages[version]) continue;

        const pkg = offer.packages;

        const phpVersionRaw = offer.php_version || '7.2';
        const phpMajorMinor = phpVersionRaw.split('.').slice(0, 2).join('.');
        const mysqlVersion = offer.mysql_version || null;

        // Add no-content variant if available
        if (pkg.no_content && typeof pkg.no_content === 'string') {
          noContentPackages[version] = {
            name: 'solidbunch/wordpress-core-no-content',
            version,
            type: 'wordpress-core',
            require: {
              php: `>=${phpMajorMinor}`
            },
            dist: {
              type: 'zip',
              url: pkg.no_content
            },
            ...(mysqlVersion && {
              extra: {
                mysql_version: mysqlVersion
              }
            })
          };
        }

        // Add full variant if available
        if (pkg.full && typeof pkg.full === 'string') {
          fullPackages[version] = {
            name: 'solidbunch/wordpress-core-full',
            version,
            type: 'wordpress-core',
            require: {
              php: `>=${phpMajorMinor}`
            },
            dist: {
              type: 'zip',
              url: pkg.full
            },
            ...(mysqlVersion && {
              extra: {
                mysql_version: mysqlVersion
              }
            })
          };
        }
      }

      if (Object.keys(noContentPackages).length === 0 && Object.keys(fullPackages).length === 0) {
        console.error('❌ No valid WordPress releases found.');
        process.exit(1);
      }

      const result = {
        packages: {
          ...(Object.keys(noContentPackages).length > 0 && {
            'solidbunch/wordpress-core-no-content': noContentPackages
          }),
          ...(Object.keys(fullPackages).length > 0 && {
            'solidbunch/wordpress-core-full': fullPackages
          })
        }
      };

      fs.writeFileSync('packages.json', JSON.stringify(result, null, 2));
      console.log(`✅ Generated packages.json with:
  - ${Object.keys(noContentPackages).length} no-content versions
  - ${Object.keys(fullPackages).length} full versions`);
    } catch (err) {
      console.error('❌ Failed to parse or write packages.json:', err);
      process.exit(1);
    }
  });
}).on('error', (err) => {
  console.error('❌ Failed to fetch WordPress version info:', err);
  process.exit(1);
});