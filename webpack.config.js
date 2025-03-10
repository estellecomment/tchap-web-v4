/* eslint-disable max-len */
/* eslint-disable quote-props */

const dotenv = require("dotenv");
const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const OptimizeCSSAssetsPlugin = require("optimize-css-assets-webpack-plugin");
const HtmlWebpackInjectPreload = require("@principalstudio/html-webpack-inject-preload");
const { sentryWebpackPlugin } = require("@sentry/webpack-plugin");
const crypto = require("crypto");

// XXX: mangle Crypto::createHash to replace md4 with sha256, output.hashFunction is insufficient as multiple bits
// of webpack hardcode md4. The proper fix it to upgrade to webpack 5.
const createHash = crypto.createHash;
crypto.createHash = (algorithm, options) => createHash(algorithm === "md4" ? "sha256" : algorithm, options);

// Environment variables
// RIOT_OG_IMAGE_URL: specifies the URL to the image which should be used for the opengraph logo.
// CSP_EXTRA_SOURCE: specifies a URL which should be appended to each CSP directive which uses 'self',
//   this can be helpful if your deployment has redirects for old bundles, such as develop.element.io.

dotenv.config();
let ogImageUrl = process.env.RIOT_OG_IMAGE_URL;
if (!ogImageUrl) ogImageUrl = "https://app.element.io/themes/element/img/logos/opengraph.png";

if (!process.env.VERSION) {
    console.warn("Unset VERSION variable - this may affect build output");
    process.env.VERSION = "!!UNSET!!";
}

const cssThemes = {
    // CSS themes
    //"theme-legacy-light": "./node_modules/matrix-react-sdk/res/themes/legacy-light/css/legacy-light.pcss",
    //"theme-legacy-dark": "./node_modules/matrix-react-sdk/res/themes/legacy-dark/css/legacy-dark.pcss",
    //"theme-light": "./node_modules/matrix-react-sdk/res/themes/light/css/light.pcss",
    "theme-light-high-contrast":
        "./node_modules/matrix-react-sdk/res/themes/light-high-contrast/css/light-high-contrast.pcss",
    //"theme-dark": "./node_modules/matrix-react-sdk/res/themes/dark/css/dark.pcss",
    //"theme-light-custom": "./node_modules/matrix-react-sdk/res/themes/light-custom/css/light-custom.pcss",
    //"theme-dark-custom": "./node_modules/matrix-react-sdk/res/themes/dark-custom/css/dark-custom.pcss",
    //:tchap: use path from our project
    "theme-light": "./res/themes/tchap-light/css/tchap-light.pcss",
    "theme-dark": "./res/themes/tchap-dark/css/tchap-dark.pcss",
};

function getActiveThemes() {
    // :old: :TCHAP: We need both themes to avoid "unknown theme light-custom" or "unknown theme light"
    // :old: :TCHAP: being thrown on login page.
    // :old: :TCHAP: Browsers recover, but e2e tests crash, so we add both themes in default here.
    // Default to `light,dark` theme when the MATRIX_THEMES environment variable is not defined.
    const theme = process.env.MATRIX_THEMES ?? "light,dark";
    return theme
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

// See docs/customisations.md
let fileOverrides = {
    /* {[file: string]: string} */
};
try {
    fileOverrides = require("./customisations.json");

    // stringify the output so it appears in logs correctly, as large files can sometimes get
    // represented as `<Object>` which is less than helpful.
    console.log("Using customisations.json : " + JSON.stringify(fileOverrides, null, 4));

    process.on("exit", () => {
        console.log(""); // blank line
        console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.warn("!! Customisations have been deprecated and will be removed in a future release      !!");
        console.warn("!! See https://github.com/vector-im/element-web/blob/develop/docs/customisations.md !!");
        console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.log(""); // blank line
    });
} catch (e) {
    // ignore - not important
}

function parseOverridesToReplacements(overrides) {
    return Object.entries(overrides).map(([oldPath, newPath]) => {
        return new webpack.NormalModuleReplacementPlugin(
            // because the input is effectively defined by the person running the build, we don't
            // need to do anything special to protect against regex overrunning, etc.
            new RegExp(oldPath.replace(/\//g, "[\\/\\\\]").replace(/\./g, "\\.")),
            path.resolve(__dirname, newPath),
        );
    });
}

const moduleReplacementPlugins = [
    ...parseOverridesToReplacements(require("./components.json")),

    // Allow customisations to override the default components too
    ...parseOverridesToReplacements(fileOverrides),
];

module.exports = (env, argv) => {
    // Establish settings based on the environment and args.
    //
    // argv.mode is always set to "production" by yarn build
    //      (called to build prod, nightly and develop.element.io)
    // arg.mode is set to "development" by yarn start
    //      (called by developers, runs the continuous reload script)
    // process.env.CI_PACKAGE is set when yarn build is called from scripts/ci_package.sh
    //      (called to build nightly and develop.element.io)
    const nodeEnv = argv.mode;
    const devMode = nodeEnv !== "production";
    const useHMR = process.env.CSS_HOT_RELOAD === "1" && devMode;
    const enableMinification = !devMode && !process.env.CI_PACKAGE;

    const development = {};
    if (devMode) {
        // Embedded source maps for dev builds, can't use eval-source-map due to CSP
        development["devtool"] = "inline-source-map";
    } else {
        if (process.env.CI_PACKAGE) {
            // High quality source maps in separate .map files which include the source. This doesn't bulk up the .js
            // payload file size, which is nice for performance but also necessary to get the bundle to a small enough
            // size that sentry will accept the upload.
            development["devtool"] = "source-map";
        } else {
            // High quality source maps in separate .map files which don't include the source
            development["devtool"] = "nosources-source-map";
        }
    }

    // Resolve the directories for the react-sdk and js-sdk for later use. We resolve these early, so we
    // don't have to call them over and over. We also resolve to the package.json instead of the src
    // directory, so we don't have to rely on an index.js or similar file existing.
    const reactSdkSrcDir = path.resolve(require.resolve("matrix-react-sdk/package.json"), "..", "src");
    const jsSdkSrcDir = path.resolve(require.resolve("matrix-js-sdk/package.json"), "..", "src");

    const ACTIVE_THEMES = getActiveThemes();
    function getThemesImports() {
        const imports = ACTIVE_THEMES.map((t) => {
            if (useHMR) {
                //:tchap: path is taken from src/vector/devcss.ts more info -> search "use theming"
                return cssThemes[`theme-${t}`].replace(".", "../../");
            }

            // return cssThemes[`theme-${t}`].replace("./node_modules/", ""); // theme import path
            return cssThemes[`theme-${t}`];
        });
        const s = JSON.stringify(ACTIVE_THEMES);
        return `
            window.MX_insertedThemeStylesCounter = 0;
            window.MX_DEV_ACTIVE_THEMES = (${s});
            ${imports.map((i) => `import("${i}")`).join("\n")};
        `;
    }

    return {
        ...development,
        node: {
            // Mock out the NodeFS module: The opus decoder imports this wrongly.
            fs: "empty",
            net: "empty",
            tls: "empty",
            crypto: "empty",
        },

        entry: {
            bundle: "./src/vector/index.ts",
            mobileguide: "./src/vector/mobile_guide/index.ts",
            jitsi: "./src/vector/jitsi/index.ts",
            usercontent: "./node_modules/matrix-react-sdk/src/usercontent/index.ts",
            ...(useHMR ? {} : cssThemes),
        },

        optimization: {
            // Put all of our CSS into one useful place - this is needed for MiniCssExtractPlugin.
            // Previously we used a different extraction plugin that did this magic for us, but
            // now we need to consider that the CSS needs to be bundled up together.
            splitChunks: {
                cacheGroups: {
                    styles: {
                        name: "styles",
                        test: /\.css$/,
                        enforce: true,
                        // Do not add `chunks: 'all'` here because you'll break the app entry point.
                    },
                    default: {
                        reuseExistingChunk: true,
                    },
                },
            },

            // This fixes duplicate files showing up in chrome with sourcemaps enabled.
            // See https://github.com/webpack/webpack/issues/7128 for more info.
            namedModules: false,

            // Minification is normally enabled by default for webpack in production mode, but
            // we use a CSS optimizer too and need to manage it ourselves.
            minimize: enableMinification,
            minimizer: enableMinification ? [new TerserPlugin({}), new OptimizeCSSAssetsPlugin({})] : [],

            // Set the value of `process.env.NODE_ENV` for libraries like React
            // See also https://v4.webpack.js.org/configuration/optimization/#optimizationnodeenv
            nodeEnv,
        },

        resolve: {
            // We define an alternative import path so we can safely use src/ across the react-sdk
            // and js-sdk. We already import from src/ where possible to ensure our source maps are
            // extremely accurate (and because we're capable of compiling the layers manually rather
            // than relying on partially-mangled output from babel), though we do need to fix the
            // package level import (stuff like `import {Thing} from "matrix-js-sdk"` for example).
            // We can't use the aliasing down below to point at src/ because that'll fail to resolve
            // the package.json for the dependency. Instead, we rely on the package.json of each
            // layer to have our custom alternate fields to load things in the right order. These are
            // the defaults of webpack prepended with `matrix_src_`.
            mainFields: ["matrix_src_browser", "matrix_src_main", "browser", "main"],
            aliasFields: ["matrix_src_browser", "browser"],

            // We need to specify that TS can be resolved without an extension
            extensions: [".js", ".json", ".ts", ".tsx"],
            alias: {
                // alias any requires to the react module to the one in our path,
                // otherwise we tend to get the react source included twice when
                // using `npm link` / `yarn link`.
                "react": path.resolve(__dirname, "node_modules/react"),
                "react-dom": path.resolve(__dirname, "node_modules/react-dom"),

                // Same goes for js/react-sdk - we don't need two copies.
                "matrix-js-sdk": path.resolve(__dirname, "node_modules/matrix-js-sdk"),
                "matrix-react-sdk": path.resolve(__dirname, "node_modules/matrix-react-sdk"),
                // and matrix-events-sdk & matrix-widget-api
                "matrix-events-sdk": path.resolve(__dirname, "node_modules/matrix-events-sdk"),
                "matrix-widget-api": path.resolve(__dirname, "node_modules/matrix-widget-api"),

                // Define a variable so the i18n stuff can load
                "$webapp": path.resolve(__dirname, "webapp"),
            },
        },

        module: {
            noParse: [
                // for cross platform compatibility use [\\\/] as the path separator
                // this ensures that the regex trips on both Windows and *nix

                // don't parse the languages within highlight.js. They cause stack
                // overflows (https://github.com/webpack/webpack/issues/1721), and
                // there is no need for webpack to parse them - they can just be
                // included as-is.
                /highlight\.js[\\/]lib[\\/]languages/,

                // olm takes ages for webpack to process, and it's already heavily
                // optimised, so there is little to gain by us uglifying it.
                /olm[\\/](javascript[\\/])?olm\.js$/,
            ],
            rules: [
                useHMR && {
                    test: /devcss\.ts$/,
                    loader: "string-replace-loader",
                    options: {
                        search: '"use theming";',
                        replace: getThemesImports(),
                    },
                },
                {
                    test: /\.worker\.ts$/,
                    loader: "worker-loader",
                    options: {
                        // Prevent bundling workers since CSP forbids loading them
                        // from another origin.
                        filename: "[hash].worker.js",
                    },
                },
                {
                    test: /\.(ts|js)x?$/,
                    include: (f) => {
                        // our own source needs babel-ing
                        if (f.startsWith(path.resolve(__dirname, "src"))) return true;

                        // we use the original source files of react-sdk and js-sdk, so we need to
                        // run them through babel. Because the path tested is the resolved, absolute
                        // path, these could be anywhere thanks to yarn link. We must also not
                        // include node modules inside these modules, so we add 'src'.
                        if (f.startsWith(reactSdkSrcDir)) return true;
                        if (f.startsWith(jsSdkSrcDir)) return true;

                        // Some of the syntax in this package is not understood by
                        // either webpack or our babel setup.
                        // When we do get to upgrade our current setup, this should
                        // probably be removed.
                        if (f.includes("@vector-im/compound-web")) return true;

                        // but we can't run all of our dependencies through babel (many of them still
                        // use module.exports which breaks if babel injects an 'include' for its
                        // polyfills: probably fixable but babeling all our dependencies is probably
                        // not necessary anyway). So, for anything else, don't babel.
                        return false;
                    },
                    loader: "babel-loader",
                    options: {
                        cacheDirectory: true,
                    },
                },
                {
                    test: /\.css$/,
                    use: [
                        MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader",
                            options: {
                                importLoaders: 1,
                                sourceMap: true,
                            },
                        },
                        {
                            loader: "postcss-loader",
                            ident: "postcss",
                            options: {
                                "sourceMap": true,
                                "plugins": () => [
                                    // Note that we use significantly fewer plugins on the plain
                                    // CSS parser. If we start to parse plain CSS, we end with all
                                    // kinds of nasty problems (like stylesheets not loading).
                                    //
                                    // You might have noticed that we're also sending regular CSS
                                    // through PostCSS. This looks weird, and in fact is probably
                                    // not what you'd expect, however in order for our CSS build
                                    // to work nicely we have to do this. Because down the line
                                    // our SCSS stylesheets reference plain CSS we have to load
                                    // the plain CSS through PostCSS so it can find it safely. This
                                    // also acts like a babel-for-css by transpiling our (S)CSS
                                    // down/up to the right browser support (prefixes, etc).
                                    // Further, if we don't do this then PostCSS assumes that our
                                    // plain CSS is SCSS and it really doesn't like that, even
                                    // though plain CSS should be compatible. The chunking options
                                    // at the top of this webpack config help group the SCSS and
                                    // plain CSS together for the bundler.

                                    require("postcss-simple-vars")(),
                                    require("postcss-hexrgba")(),

                                    // It's important that this plugin is last otherwise we end
                                    // up with broken CSS.
                                    require("postcss-preset-env")({ stage: 3, browsers: "last 2 versions" }),
                                ],
                                "parser": "postcss-scss",
                                "local-plugins": true,
                            },
                        },
                    ],
                },
                {
                    test: /\.pcss$/,
                    use: [
                        /**
                         * This code is hopeful that no .pcss outside of our themes will be directly imported in any
                         * of the JS/TS files.
                         * Should be MUCH better with webpack 5, but we're stuck to this solution for now.
                         */
                        useHMR
                            ? {
                                  loader: "style-loader",
                                  /**
                                   * If we refactor the `theme.js` in `matrix-react-sdk` a little bit,
                                   * we could try using `lazyStyleTag` here to add and remove styles on demand,
                                   * that would nicely resolve issues of race conditions for themes,
                                   * at least for development purposes.
                                   */
                                  options: {
                                      insert: function insertBeforeAt(element) {
                                          const parent = document.querySelector("head");
                                          // We're in iframe
                                          if (!window.MX_DEV_ACTIVE_THEMES) {
                                              parent.appendChild(element);
                                              return;
                                          }
                                          // Properly disable all other instances of themes
                                          element.disabled = true;
                                          element.onload = () => {
                                              element.disabled = true;
                                          };
                                          const theme =
                                              window.MX_DEV_ACTIVE_THEMES[window.MX_insertedThemeStylesCounter];
                                          element.setAttribute("data-mx-theme", theme);
                                          window.MX_insertedThemeStylesCounter++;
                                          parent.appendChild(element);
                                      },
                                  },
                              }
                            : MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader",
                            options: {
                                importLoaders: 1,
                                sourceMap: true,
                            },
                        },
                        {
                            loader: "postcss-loader",
                            ident: "postcss",
                            options: {
                                "sourceMap": true,
                                "plugins": () => [
                                    // Note that we use slightly different plugins for PostCSS.
                                    require("postcss-import")(),
                                    require("postcss-mixins")(),
                                    require("postcss-simple-vars")(),
                                    require("postcss-nested")(),
                                    require("postcss-easings")(),
                                    require("postcss-hexrgba")(),

                                    // It's important that this plugin is last otherwise we end
                                    // up with broken CSS.
                                    require("postcss-preset-env")({ stage: 3, browsers: "last 2 versions" }),
                                ],
                                "parser": "postcss-scss",
                                "local-plugins": true,
                            },
                        },
                    ],
                },
                {
                    // the olm library wants to load its own wasm, rather than have webpack do it.
                    // We therefore use the `file-loader` to tell webpack to dump the contents to
                    // a separate file and return the name, and override the default `type` for `.wasm` files
                    // (which is `webassembly/experimental` under webpack 4) to stop webpack trying to interpret
                    // the filename as webassembly. (see also https://github.com/webpack/webpack/issues/6725)
                    test: /olm\.wasm$/,
                    loader: "file-loader",
                    type: "javascript/auto",
                    options: {
                        name: "[name].[hash:7].[ext]",
                        outputPath: ".",
                    },
                },
                {
                    // Fix up the name of the opus-recorder worker (react-sdk dependency).
                    // We more or less just want it to be clear it's for opus and not something else.
                    test: /encoderWorker\.min\.js$/,
                    loader: "file-loader",
                    type: "javascript/auto",
                    options: {
                        // We deliberately override the name so it makes sense in debugging
                        name: "opus-encoderWorker.min.[hash:7].[ext]",
                        outputPath: ".",
                    },
                },
                {
                    // Special case the recorder worklet as it can't end up HMR'd, but the worker-loader
                    // isn't good enough for us. Note that the worklet-loader is listed as "do not use",
                    // however it seems to work fine for our purposes.
                    test: /RecorderWorklet\.ts$/,
                    type: "javascript/auto",
                    use: [
                        // executed last -> first, for some reason.
                        {
                            loader: "worklet-loader",
                            options: {
                                // Override name so we know what it is in the output.
                                name: "recorder-worklet.[hash:7].js",
                            },
                        },
                        {
                            // TS -> JS because the worklet-loader won't do this for us.
                            loader: "babel-loader",
                        },
                    ],
                },
                {
                    // This is from the same place as the encoderWorker above, but only needed
                    // for Safari support.
                    test: /decoderWorker\.min\.js$/,
                    loader: "file-loader",
                    type: "javascript/auto", // https://github.com/webpack/webpack/issues/6725
                    options: {
                        // We deliberately override the name so it makes sense in debugging
                        name: "opus-decoderWorker.min.[hash:7].[ext]",
                        outputPath: ".",
                    },
                },
                {
                    // Same deal as olm.wasm: the decoderWorker wants to load the wasm artifact
                    // itself.
                    test: /decoderWorker\.min\.wasm$/,
                    loader: "file-loader",
                    type: "javascript/auto",
                    options: {
                        // We deliberately don't change the name because the decoderWorker has this
                        // hardcoded. This is here to avoid the default wasm rule from adding a hash.
                        name: "decoderWorker.min.wasm",
                        outputPath: ".",
                    },
                },
                {
                    // This is from the same place as the encoderWorker above, but only needed
                    // for Safari support.
                    test: /waveWorker\.min\.js$/,
                    loader: "file-loader",
                    type: "javascript/auto", // https://github.com/webpack/webpack/issues/6725
                    options: {
                        // We deliberately override the name so it makes sense in debugging
                        name: "wave-encoderWorker.min.[hash:7].[ext]",
                        outputPath: ".",
                    },
                },
                {
                    // cache-bust languages.json file placed in
                    // element-web/webapp/i18n during build by copy-res.js
                    test: /\.*languages.json$/,
                    type: "javascript/auto",
                    loader: "file-loader",
                    options: {
                        name: "i18n/[name].[hash:7].[ext]",
                    },
                },
                {
                    test: /\.svg$/,
                    issuer: /\.(js|ts|jsx|tsx|html)$/,
                    use: [
                        {
                            loader: "@svgr/webpack",
                            options: {
                                namedExport: "Icon",
                                svgProps: {
                                    "role": "presentation",
                                    "aria-hidden": true,
                                },
                                // props set on the svg will override defaults
                                expandProps: "end",
                                svgoConfig: {
                                    plugins: {
                                        // generates a viewbox if missing
                                        removeDimensions: true,
                                    },
                                },
                                esModule: false,
                                name: "[name].[hash:7].[ext]",
                                outputPath: getAssetOutputPath,
                                publicPath: function (url, resourcePath) {
                                    const outputPath = getAssetOutputPath(url, resourcePath);
                                    return toPublicPath(outputPath);
                                },
                            },
                        },
                        {
                            loader: "file-loader",
                            options: {
                                esModule: false,
                                name: "[name].[hash:7].[ext]",
                                outputPath: getAssetOutputPath,
                                publicPath: function (url, resourcePath) {
                                    const outputPath = getAssetOutputPath(url, resourcePath);
                                    return toPublicPath(outputPath);
                                },
                            },
                        },
                    ],
                },
                {
                    test: /\.svg$/,
                    issuer: /\.(pcss|scss|css)$/,
                    use: [
                        {
                            loader: "file-loader",
                            options: {
                                esModule: false,
                                name: "[name].[hash:7].[ext]",
                                outputPath: getAssetOutputPath,
                                publicPath: function (url, resourcePath) {
                                    // CSS image usages end up in the `bundles/[hash]` output
                                    // directory, so we adjust the final path to navigate up
                                    // twice.
                                    const outputPath = getAssetOutputPath(url, resourcePath);
                                    return toPublicPath(path.join("../..", outputPath));
                                },
                            },
                        },
                    ],
                },
                {
                    test: /\.(gif|png|ttf|woff|woff2|xml|ico)$/,
                    // Use a content-based hash in the name so that we can set a long cache
                    // lifetime for assets while still delivering changes quickly.
                    oneOf: [
                        {
                            // Assets referenced in CSS files
                            issuer: /\.(pcss|scss|css)$/,
                            loader: "file-loader",
                            options: {
                                esModule: false,
                                name: "[name].[hash:7].[ext]",
                                outputPath: getAssetOutputPath,
                                publicPath: function (url, resourcePath) {
                                    // CSS image usages end up in the `bundles/[hash]` output
                                    // directory, so we adjust the final path to navigate up
                                    // twice.
                                    const outputPath = getAssetOutputPath(url, resourcePath);
                                    return toPublicPath(path.join("../..", outputPath));
                                },
                            },
                        },
                        {
                            // Assets referenced in HTML and JS files
                            loader: "file-loader",
                            options: {
                                esModule: false,
                                name: "[name].[hash:7].[ext]",
                                outputPath: getAssetOutputPath,
                                publicPath: function (url, resourcePath) {
                                    const outputPath = getAssetOutputPath(url, resourcePath);
                                    return toPublicPath(outputPath);
                                },
                            },
                        },
                    ],
                },
            ].filter(Boolean),
        },

        plugins: [
            ...moduleReplacementPlugins,

            // This exports our CSS using the splitChunks and loaders above.
            new MiniCssExtractPlugin({
                filename: useHMR ? "bundles/[name].css" : "bundles/[hash]/[name].css",
                chunkFilename: useHMR ? "bundles/[name].css" : "bundles/[hash]/[name].css",
                ignoreOrder: false, // Enable to remove warnings about conflicting order
            }),

            // This is the app's main entry point.
            new HtmlWebpackPlugin({
                template: "./src/vector/index.html",

                // we inject the links ourselves via the template, because
                // HtmlWebpackPlugin will screw up our formatting like the names
                // of the themes and which chunks we actually care about.
                inject: false,
                excludeChunks: ["mobileguide", "usercontent", "jitsi"],
                minify: false,
                templateParameters: {
                    og_image_url: ogImageUrl,
                    csp_extra_source: process.env.CSP_EXTRA_SOURCE ?? "",
                },
            }),

            // This is the jitsi widget wrapper (embedded, so isolated stack)
            new HtmlWebpackPlugin({
                template: "./src/vector/jitsi/index.html",
                filename: "jitsi.html",
                minify: false,
                chunks: ["jitsi"],
            }),

            // This is the mobile guide's entry point (separate for faster mobile loading)
            new HtmlWebpackPlugin({
                template: "./src/vector/mobile_guide/index.html",
                filename: "mobile_guide/index.html",
                minify: false,
                chunks: ["mobileguide"],
            }),

            // These are the static error pages for when the javascript env is *really unsupported*
            new HtmlWebpackPlugin({
                template: "./src/vector/static/unable-to-load.html",
                filename: "static/unable-to-load.html",
                minify: false,
                chunks: [],
            }),
            new HtmlWebpackPlugin({
                template: "./src/vector/static/incompatible-browser.html",
                filename: "static/incompatible-browser.html",
                minify: false,
                chunks: [],
            }),

            // This is the usercontent sandbox's entry point (separate for iframing)
            new HtmlWebpackPlugin({
                template: "./node_modules/matrix-react-sdk/src/usercontent/index.html",
                filename: "usercontent/index.html",
                minify: false,
                chunks: ["usercontent"],
            }),

            new HtmlWebpackInjectPreload({
                files: [{ match: /.*Inter.*\.woff2$/ }],
            }),

            // upload to sentry if sentry env is present
            process.env.SENTRY_DSN &&
                sentryWebpackPlugin({
                    release: process.env.VERSION,
                    sourcemaps: {
                        paths: "./webapp/bundles/**",
                    },
                    errorHandler: (err, invokeErr, compilation) => {
                        compilation.warnings.push("Sentry CLI Plugin: " + err.message);
                        console.log(`::warning title=Sentry error::${err.message}`);
                    },
                }),
            new webpack.EnvironmentPlugin(["VERSION"]),
        ].filter(Boolean),

        output: {
            path: path.join(__dirname, "webapp"),

            // The generated JS (and CSS, from the extraction plugin) are put in a
            // unique subdirectory for the build. There will only be one such
            // 'bundle' directory in the generated tarball; however, hosting
            // servers can collect 'bundles' from multiple versions into one
            // directory and symlink it into place - this allows users who loaded
            // an older version of the application to continue to access webpack
            // chunks even after the app is redeployed.
            filename: "bundles/[hash]/[name].js",
            chunkFilename: "bundles/[hash]/[name].js",
            webassemblyModuleFilename: "bundles/[hash]/[modulehash].wasm",
        },

        // configuration for the webpack-dev-server
        devServer: {
            // serve unwebpacked assets from webapp.
            contentBase: ["./webapp"],

            // Only output errors, warnings, or new compilations.
            // This hides the massive list of modules.
            stats: "minimal",
            hotOnly: true,
            inline: true,
        },
    };
};

/**
 * Merge assets found via CSS and imports into a single tree, while also preserving
 * directories under e.g. `res` or similar.
 *
 * @param {string} url The adjusted name of the file, such as `warning.1234567.svg`.
 * @param {string} resourcePath The absolute path to the source file with unmodified name.
 * @return {string} The returned paths will look like `img/warning.1234567.svg`.
 */
function getAssetOutputPath(url, resourcePath) {
    // `res` is the parent dir for our own assets in various layers
    // `dist` is the parent dir for KaTeX assets
    const prefix = /^.*[/\\](dist|res)[/\\]/;
    if (!resourcePath.match(prefix)) {
        throw new Error(`Unexpected asset path: ${resourcePath}`);
    }
    let outputDir = path.dirname(resourcePath).replace(prefix, "");
    if (resourcePath.includes("KaTeX")) {
        // Add a clearly named directory segment, rather than leaving the KaTeX
        // assets loose in each asset type directory.
        outputDir = path.join(outputDir, "KaTeX");
    }
    return path.join(outputDir, path.basename(url));
}

/**
 * Convert path to public path format, which always uses forward slashes, since it will
 * be placed directly into things like CSS files.
 *
 * @param {string} path Some path to a file.
 * @returns {string} converted path
 */
function toPublicPath(path) {
    return path.replace(/\\/g, "/");
}
