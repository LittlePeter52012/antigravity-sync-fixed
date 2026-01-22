const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration[]} */
module.exports = [
  // Extension (Node.js)
  {
    name: 'extension',
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2'
    },
    externals: [
      { vscode: 'commonjs vscode' },
      // Externalize native node modules
      /^fsevents$/,
      /\.node$/,
      // Optional WebSocket dependencies (not needed, just removes warnings)
      { bufferutil: 'commonjs bufferutil' },
      { 'utf-8-validate': 'commonjs utf-8-validate' }
    ],
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: path.resolve(__dirname, 'tsconfig.json')
            }
          }
        }
      ]
    },
    devtool: 'nosources-source-map'
  },
  // Webview (Browser)
  {
    name: 'webview',
    target: 'web',
    mode: 'none',
    entry: './webview/src/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist', 'webview'),
      filename: 'main.js'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: path.resolve(__dirname, 'webview/tsconfig.json')
            }
          }
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader']
        }
      ]
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'webview/media', to: 'media', noErrorOnMissing: true }
        ]
      })
    ],
    devtool: 'nosources-source-map'
  }
];
