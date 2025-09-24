import { Configuration } from 'webpack';

/** @type {import('next').NextConfig} */
const nextConfig = {

  webpack: (config: Configuration) => {
    if (config.module && config.module.rules) {
        config.module.rules.push({
          test: /\.map$/,
          use: 'ignore-loader',
        });
    }

    return config;
  },
};

module.exports = nextConfig;

