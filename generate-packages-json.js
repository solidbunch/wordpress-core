const fs = require('fs');
const https = require('https');

// Fetch latest WordPress version info
https.get('https://api.wordpress.org/core/version-check/1.7/', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);

  res.on('end', () => {
    try {
      const offers = JSON.parse(data).offers;
      const latest = offers.find(v => v.response === 'upgrade');

      const version = latest.current;
      const phpVersion = latest.php_version || '8.0'; // fallback if missing

      const json = {
        packages: {
          "solidbunch/wordpress-core": {
            [version]: {
              name: "solidbunch/wordpress-core",
              version: version,
              type: "wordpress-core",
              require: {
                php: `>=${phpVersion}`
              },
              dist: {
                type: "zip",
                url: `https://wordpress.org/wordpress-${version}.zip`
              }
            }
          }
        }
      };

      fs.writeFileSync('packages.json', JSON.stringify(json, null, 2));
      console.log(`✅ packages.json updated to WordPress ${version}, PHP >= ${phpVersion}`);
    } catch (err) {
      console.error('❌ Failed to parse or write packages.json:', err);
      process.exit(1);
    }
  });
}).on('error', (err) => {
  console.error('❌ Failed to fetch WordPress version info:', err);
  process.exit(1);
});