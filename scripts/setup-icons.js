const fs = require('fs');
const path = require('path');

// Ensure build directory exists
const buildDir = path.join(__dirname, '..', 'build');
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

// Ensure public directory exists (vite handles this, but just in case)
const publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const iconPath = path.join(buildDir, 'icon.png');

// Only create if it doesn't exist to avoid overwriting user's custom icon
if (!fs.existsSync(iconPath)) {
  console.log('⚓ Generating placeholder build icon...');
  
  // Base64 for a 512x512 Dark Blue PNG (Solid Color #0f172a)
  // This ensures electron-builder has a valid file to work with.
  const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQMAAADO76waAAAABlBMVEUADxEqKSo02VnDAAAANElEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4McAlgABil6c5AAAAABJRU5ErkJggg==";
  
  const buffer = Buffer.from(base64Png, 'base64');
  fs.writeFileSync(iconPath, buffer);
  
  console.log('✅ Created build/icon.png');
  console.log('👉 TIP: Replace build/icon.png with your own 512x512 image for the final app!');
} else {
  console.log('✅ build/icon.png already exists. Skipping generation.');
}
