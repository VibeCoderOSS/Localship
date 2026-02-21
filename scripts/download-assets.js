
const fs = require('fs');
const path = require('path');
const https = require('https');

// Helper to download a file
const downloadFile = (url, dest) => {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
        console.log(`⚡ Using cached: ${path.basename(dest)}`);
        resolve();
        return;
    }

    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`Status ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`✅ Downloaded: ${path.basename(dest)}`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
};

const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
if (!fs.existsSync(vendorDir)) {
  fs.mkdirSync(vendorDir, { recursive: true });
}

const copyLocalFile = (src, dest) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(src)) {
      reject(new Error(`Local source missing: ${src}`));
      return;
    }
    fs.copyFile(src, dest, (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log(`✅ Copied local asset: ${path.basename(dest)}`);
      resolve();
    });
  });
};

const ensureThreeModule = async () => {
  const dest = path.join(vendorDir, 'three.module.js');
  if (fs.existsSync(dest)) {
    console.log(`⚡ Using cached: ${path.basename(dest)}`);
    return;
  }

  const localThree = path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.module.js');
  if (fs.existsSync(localThree)) {
    await copyLocalFile(localThree, dest);
    return;
  }

  // Fallback only during asset preparation.
  await downloadFile('https://unpkg.com/three@0.179.1/build/three.module.js', dest);
};

console.log('⚓ Downloading Offline Assets (React UMD)...');

// SWITCH TO UMD BUILDS
// These have NO internal imports, making them 100% safe for offline blob usage.
const assets = [
    {
        url: "https://unpkg.com/tailwindcss@2.2.19/dist/tailwind.min.css",
        dest: path.join(vendorDir, "tailwind.min.css")
    },
    {
        // React UMD
        url: "https://unpkg.com/react@18.2.0/umd/react.production.min.js",
        dest: path.join(vendorDir, "react.js")
    },
    {
        // ReactDOM UMD
        url: "https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js",
        dest: path.join(vendorDir, "react-dom.js")
    }
    // We do not need a separate react-dom-client file for UMD, we will synthesize the wrapper in PreviewFrame
];

Promise.all([...assets.map(a => downloadFile(a.url, a.dest)), ensureThreeModule()])
  .then(() => console.log('✨ All offline assets ready.'))
  .catch(err => {
      console.error('❌ Failed to download assets:', err.message);
      process.exit(1);
  });
