/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    screens: {
      xs: '360px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        // Stitch "Grid & Pulse" tokens
        'surface': "#fbf9f4",
        'surface-dim': "#dbdad5",
        'surface-container-lowest': "#ffffff",
        'surface-container-low': "#f5f3ee",
        'surface-container': "#f0eee9",
        'surface-container-high': "#eae8e3",
        'surface-container-highest': "#e4e2dd",
        'on-surface': "#1b1c19",
        'on-surface-variant': "#44474d",
        'outline-variant': "#c5c6ce",
        // BijliSathi brand
        'ink-navy': "#0A1B33",
        'grid-navy': "#132A4D",
        'wire-slate': "#5A6B8C",
        'porcelain': "#F7F5F0",
        'paper': "#FFFFFF",
        'circuit-amber': "#F2A93B",
        'spark-ember': "#FF6B35",
        'signal-green': "#2E9E6B",
        'fault-red': "#D64545",
        'haze': "#C9CFDB",
        'secondary-container': "#fdb244",
        'on-secondary-container': "#6e4600",
        'error-container': "#ffdad6",
        'on-error-container': "#93000a",
      },
      fontFamily: {
        display: ["Sora", "Inter", "sans-serif"],
        body: ["Inter", "IBM Plex Sans", "IBM Plex Sans Devanagari", "sans-serif"],
        mono: ["JetBrains Mono", "IBM Plex Mono", "monospace"],
        kesco: ["Inter", "Geist", "Sora", "sans-serif"],
      },
      borderRadius: {
        sm: "0.25rem",
        DEFAULT: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
        md: "14px",
      },
      boxShadow: {
        card: "0 4px 6px -1px rgba(10,27,51,0.05), 0 2px 4px -1px rgba(10,27,51,0.03)",
        raised: "0 8px 24px rgba(10,27,51,0.12)",
        'glow-amber': "0 0 15px 2px rgba(242,169,59,0.3)",
      },
    },
  },
  plugins: [],
}
