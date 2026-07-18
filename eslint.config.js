export default [
  {
    ignores: ["node_modules/**", "data/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-constant-binary-expression": "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "prefer-const": "error"
    },
  },
];
