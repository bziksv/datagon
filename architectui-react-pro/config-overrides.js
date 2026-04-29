const path = require('path');

module.exports = function(config, env) {
    // Essential polyfills for Node.js modules
    config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        buffer: require.resolve('buffer/'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        assert: require.resolve('assert'),
        http: require.resolve('stream-http'),
        https: require.resolve('https-browserify'),
        url: require.resolve('url'),
        vm: false,
    };

    // Only rc-tabs aliases (no React aliases to avoid resolution issues)
    config.resolve.alias = {
        ...(config.resolve.alias || {}),
        'rc-tabs/lib/ScrollableInkTabBar': path.resolve(__dirname, 'src/rc-tabs-shims/ScrollableInkTabBar.js'),
        'rc-tabs/lib/SwipeableTabContent': path.resolve(__dirname, 'src/rc-tabs-shims/SwipeableTabContent.js'),
        'rc-tabs$': path.resolve(__dirname, 'src/rc-tabs-shims/rc-tabs-wrapper.js'),
    };

    // react-router 7.x package.json "exports" point at dist/development, so production CRA
    // bundles ENABLE_DEV_WARNINGS=true and spams console (e.g. "No routes matched location …").
    // Force the production builds for NODE_ENV=production (same as RR's own prod entrypoints).
    if (env === 'production') {
        const rrProd = path.resolve(__dirname, 'node_modules/react-router/dist/production');
        config.resolve.alias['react-router$'] = path.join(rrProd, 'index.js');
        config.resolve.alias['react-router/dom'] = path.join(rrProd, 'dom-export.js');
    }

    // Comprehensive warning suppression for cleaner development experience
    config.ignoreWarnings = [
        // Suppress all source map loader warnings
        {
            module: /source-map-loader/,
        },
        // Suppress specific react-datepicker source map warnings
        /Failed to parse source map.*react-datepicker/,
        // Suppress general source map parsing failures
        /Failed to parse source map/,
        // Function-based warning filter for additional cases
        function(warning) {
            return (
                warning.module &&
                warning.module.resource &&
                (warning.module.resource.includes('node_modules') ||
                 warning.module.resource.includes('react-datepicker')) &&
                warning.message &&
                (warning.message.includes('Failed to parse source map') ||
                 warning.message.includes('source map'))
            );
        }
    ];

    // После переезда проекта старый babel/webpack cache может держать абсолютные пути к
    // прежней папке и ломать HtmlWebpackPlugin. Явно привязываем шаблон к этому репо.
    const appHtml = path.resolve(__dirname, 'public', 'index.html');
    for (const plugin of config.plugins || []) {
        if (!plugin || plugin.constructor.name !== 'HtmlWebpackPlugin') continue;
        if (plugin.userOptions && typeof plugin.userOptions === 'object') {
            plugin.userOptions.template = appHtml;
        }
        if (plugin.options && typeof plugin.options === 'object') {
            plugin.options.template = appHtml;
        }
        break;
    }

    return config;
};

// Webpack-dev-server v5 compatibility override for react-scripts 5.0.1
module.exports.devServer = function(configFunction) {
    return function(proxy, allowedHost) {
        const config = configFunction(proxy, allowedHost);
        
        console.log('🔧 Applying webpack-dev-server v5 compatibility fixes...');
        
        // Convert deprecated v4 API to v5 API
        if (config.onAfterSetupMiddleware) {
            console.log('  - Converting onAfterSetupMiddleware to setupMiddlewares');
            const originalOnAfter = config.onAfterSetupMiddleware;
            config.setupMiddlewares = (middlewares, devServer) => {
                originalOnAfter(devServer);
                return middlewares;
            };
            delete config.onAfterSetupMiddleware;
        }
        
        if (config.onBeforeSetupMiddleware) {
            console.log('  - Converting onBeforeSetupMiddleware to setupMiddlewares');
            const originalOnBefore = config.onBeforeSetupMiddleware;
            const existingSetupMiddlewares = config.setupMiddlewares;
            config.setupMiddlewares = (middlewares, devServer) => {
                originalOnBefore(devServer);
                return existingSetupMiddlewares ? existingSetupMiddlewares(middlewares, devServer) : middlewares;
            };
            delete config.onBeforeSetupMiddleware;
        }
        
        // Convert https boolean to server object for v5
        if (config.https === true) {
            console.log('  - Converting https: true to server: "https"');
            config.server = 'https';
            delete config.https;
        } else if (config.https === false) {
            console.log('  - Converting https: false to server: "http"');
            config.server = 'http';
            delete config.https;
        } else if (config.https && typeof config.https === 'object') {
            console.log('  - Converting https object to server object');
            config.server = {
                type: 'https',
                options: config.https
            };
            delete config.https;
        }
        
        // HMR WebSocket: на нестандартном PORT (например 3003) без этого клиент иногда
        // стучится не туда и в консоли «Invalid frame header».
        config.client = config.client || {};
        if (config.client.webSocketURL == null) {
            config.client.webSocketURL = 'auto://0.0.0.0:0/ws';
        }

        console.log('✅ webpack-dev-server v5 compatibility applied successfully');
        return config;
    };
}; 