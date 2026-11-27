'use strict';
// npm run lint（ESLint 是開發用套件，正式映像不安裝；面板執行時沒有 npm 依賴）

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },
  {
    // 網頁（瀏覽器端 ES modules）
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // 在 <head> 同步執行的一般 script
    files: ['public/js/theme-init.js'],
    languageOptions: { sourceType: 'script' },
  },
];
