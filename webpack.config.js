//@ts-check
'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration[]} */
const configs = [
  // Extension host (Node.js)
  {
    name: 'extension',
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
    },
    externals: {
      vscode: 'commonjs vscode',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }],
        },
      ],
    },
    devtool: 'nosources-source-map',
  },
  // Webview (browser)
  {
    name: 'webview',
    target: 'web',
    mode: 'none',
    entry: './webview-src/pdf-viewer.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'pdf-viewer.js',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json' } }],
        },
        {
          test: /\.wasm$/,
          type: 'asset/resource',
          generator: { emit: false },
        },
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm',
            to: 'pdfium.wasm',
          },
        ],
      }),
    ],
    devtool: 'nosources-source-map',
  },
  // Markdown preview script (browser)
  {
    name: 'markdown-preview',
    target: 'web',
    mode: 'none',
    entry: './webview-src/markdown-preview.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'markdown-preview.js',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json' } }],
        },
      ],
    },
    devtool: 'nosources-source-map',
  },
];

module.exports = configs;
