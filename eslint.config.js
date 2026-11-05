'use strict';
// 面板沒有 npm 依賴；要跑 lint 時借用 Mousebot 的 eslint：
//   npx --prefix ../Mousebot eslint -c eslint.config.js .
// （或在這裡 npm i -D eslint @eslint/js globals 後執行 npx eslint .）

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
