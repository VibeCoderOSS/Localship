/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./index.html",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./services/**/*.{js,ts,jsx,tsx}",
    "./utils/**/*.{js,ts,jsx,tsx}",
    "./*.{js,ts,jsx,tsx}",
    "!./node_modules/**/*"
  ],
  theme: {
    extend: {
      colors: {
        // Updated Deep Ocean Theme - More Midnight, Less Saturated Blue
        ocean: {
          950: '#020617', // Main Background (Very Dark)
          900: '#0f172a', // Secondary Background
          800: '#1e293b', // Sidebar / Cards
          700: '#334155', // Borders
          600: '#3b82f6', // Primary Action (Blue)
        },
        // Foam/Sail Theme (Light Mode)
        foam: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
        },
        teal: {
          300: '#5eead4', 
          400: '#2dd4bf',
          500: '#14b8a6',
        }
      }
    },
  },
  plugins: [],
}