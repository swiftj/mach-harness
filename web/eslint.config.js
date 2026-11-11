// Shared lint rules for every package in the MACH web workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "fixtures/**", "**/screenshots/**", "**/test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.strict.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // No colour literals in components: use the tokens. Token files and the contrast tooling are exempt below.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
          message: "Use a design token (var(--…) or a Tailwind token class), not a hex colour."
        }
      ]
    }
  },
  {
    files: ["packages/ui/src/tokens/**", "**/*.config.{js,ts}", "**/scripts/**"],
    rules: { "no-restricted-syntax": "off" }
  },
  {
    files: ["**/*.{js,mjs}", "**/scripts/**", "**/vite.config.ts"],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // Playwright scripts run some functions inside the page (page.evaluate).
    files: ["apps/*/scripts/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
);
