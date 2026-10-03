import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      ".crouter/**",
      "fixtures/**",
      "scripts/*.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": hooks },
    rules: hooks.configs.recommended.rules,
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", Buffer: "readonly", console: "readonly" },
    },
  },
);
