import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
      colors: {
        glass: {
          light: "rgba(255, 255, 255, 0.15)",
          DEFAULT: "rgba(255, 255, 255, 0.1)",
          dark: "rgba(0, 0, 0, 0.2)",
        },
        brand: {
          light: "#7dd3fc", // sky-300
          DEFAULT: "#0ea5e9", // sky-500
          dark: "#0369a1", // sky-700
        },
        // ── Matte Dark design system ──────────────────────────────────
        // Solid, high-contrast surfaces (Linear/Vercel-style) replacing the
        // washed-out glass. `alive` = the semantic "running / active" green.
        base: "#0B0D10",           // app ground (matte, no gradient)
        surface: {
          DEFAULT: "#14171C",      // card / panel
          raised: "#1B1F26",       // controls, hover base
          hi: "#1E232B",           // elevated hover
        },
        line: {
          DEFAULT: "#242A33",      // visible borders
          soft: "#1D222A",         // hairline dividers
        },
        ink: {
          DEFAULT: "#F4F6F8",      // primary text
          dim: "#9BA3AF",          // secondary text (>= 4.5:1)
          faint: "#6B7280",        // labels / muted
        },
        alive: "#22C55E",          // running server / live chrono / working
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        'gradient-x': {
          '0%, 100%': {
            'background-size': '200% 200%',
            'background-position': 'left center'
          },
          '50%': {
            'background-size': '200% 200%',
            'background-position': 'right center'
          }
        }
      },
      animation: {
        'gradient-x': 'gradient-x 15s ease infinite',
      }
    },
  },
  plugins: [],
};
export default config;
