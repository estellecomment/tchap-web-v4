/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018, 2019 New Vector Ltd
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { extractErrorMessageFromError } from "matrix-react-sdk/src/components/views/dialogs/ErrorDialog";

// These are things that can run before the skin loads - be careful not to reference the react-sdk though.
import { parseQsFromFragment } from "./url_utils";
import "./modernizr";
// eslint-disable-next-line max-len
import {
    queueClearCacheAndReload,
    queueOverideUserSettings,
    needsRefreshForVersion4,
    saveAppVersionInLocalStorage,
    registerExpiredAccountListener,
} from "../tchap/app/initTchap";

// Require common CSS here; this will make webpack process it into bundle.css.
// Our own CSS (which is themed) is imported via separate webpack entry points
// in webpack.config.js
require("gfm.css/gfm.css");
require("katex/dist/katex.css");

/**
 * This require is necessary only for purposes of CSS hot-reload, as otherwise
 * webpack has some incredible problems figuring out which CSS files should be
 * hot-reloaded, even with proper hints for the loader.
 *
 * On production build it's going to be an empty module, so don't worry about that.
 */
require("./devcss");
require("./localstorage-fix");

async function settled(...promises: Array<Promise<any>>): Promise<void> {
    for (const prom of promises) {
        try {
            await prom;
        } catch (e) {
            logger.error(e);
        }
    }
}

function checkBrowserFeatures(): boolean {
    if (!window.Modernizr) {
        logger.error("Cannot check features - Modernizr global is missing.");
        return false;
    }

    // Custom checks atop Modernizr because it doesn't have ES2018/ES2019 checks
    // in it for some features we depend on.
    // Modernizr requires rules to be lowercase with no punctuation.
    // ES2018: http://262.ecma-international.org/9.0/#sec-promise.prototype.finally
    window.Modernizr.addTest("promiseprototypefinally", () => typeof window.Promise?.prototype?.finally === "function");
    // ES2020: http://262.ecma-international.org/#sec-promise.allsettled
    window.Modernizr.addTest("promiseallsettled", () => typeof window.Promise?.allSettled === "function");
    // ES2018: https://262.ecma-international.org/9.0/#sec-get-regexp.prototype.dotAll
    window.Modernizr.addTest(
        "regexpdotall",
        () => window.RegExp?.prototype && !!Object.getOwnPropertyDescriptor(window.RegExp.prototype, "dotAll")?.get,
    );
    // ES2019: http://262.ecma-international.org/10.0/#sec-object.fromentries
    window.Modernizr.addTest("objectfromentries", () => typeof window.Object?.fromEntries === "function");

    const featureList = Object.keys(window.Modernizr) as Array<keyof ModernizrStatic>;

    let featureComplete = true;
    for (const feature of featureList) {
        if (window.Modernizr[feature] === undefined) {
            logger.error(
                "Looked for feature '%s' but Modernizr has no results for this. " + "Has it been configured correctly?",
                feature,
            );
            return false;
        }
        if (window.Modernizr[feature] === false) {
            logger.error("Browser missing feature: '%s'", feature);
            // toggle flag rather than return early so we log all missing features rather than just the first.
            featureComplete = false;
        }
    }
    return featureComplete;
}

const supportedBrowser = checkBrowserFeatures();

// React depends on Map & Set which we check for using modernizr's es6collections
// if modernizr fails we may not have a functional react to show the error message.
// try in react but fallback to an `alert`
// We start loading stuff but don't block on it until as late as possible to allow
// the browser to use as much parallelism as it can.
// Load parallelism is based on research in https://github.com/vector-im/element-web/issues/12253
async function start(): Promise<void> {
    // load init.ts async so that its code is not executed immediately and we can catch any exceptions
    const {
        rageshakePromise,
        setupLogStorage,
        preparePlatform,
        loadOlm,
        loadConfig,
        loadLanguage,
        loadTheme,
        loadApp,
        loadModules,
        showError,
        showIncompatibleBrowser,
        _t,
    } = await import(
        /* webpackChunkName: "init" */
        /* webpackPreload: true */
        "./init"
    );

    try {
        // give rageshake a chance to load/fail, we don't actually assert rageshake loads, we allow it to fail if no IDB
        await settled(rageshakePromise);

        const fragparts = parseQsFromFragment(window.location);
        //:tchap: determine if a hard refresh is needed
        const needRefreshForV4 = await needsRefreshForVersion4();
        console.log(`:TCHAP: queue a hard clear cache and reload for this version? ${needRefreshForV4}`);
        //:tchap: end

        // don't try to redirect to the native apps if we're
        // verifying a 3pid (but after we've loaded the config)
        // or if the user is following a deep link
        // (https://github.com/vector-im/element-web/issues/7378)
        const preventRedirect = fragparts.params.client_secret || fragparts.location.length > 0;

        if (!preventRedirect) {
            const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
            const isAndroid = /Android/.test(navigator.userAgent);
            if (isIos || isAndroid) {
                if (document.cookie.indexOf("element_mobile_redirect_to_guide=false") === -1) {
                    window.location.href = "mobile_guide/";
                    return;
                }
            }
        }

        const loadOlmPromise = loadOlm();
        // set the platform for react sdk
        preparePlatform();
        // load config requires the platform to be ready
        const loadConfigPromise = loadConfig();
        await settled(loadConfigPromise); // wait for it to settle

        //:tchap: save app in local storage
        saveAppVersionInLocalStorage();
        //:tchap end

        // now that the config is ready, try to persist logs
        const persistLogsPromise = setupLogStorage();

        // Load modules before language to ensure any custom translations are respected, and any app
        // startup functionality is run
        const loadModulesPromise = loadModules();
        await settled(loadModulesPromise);

        // Load language after loading config.json so that settingsDefaults.language can be applied
        const loadLanguagePromise = loadLanguage();
        // as quickly as we possibly can, set a default theme...
        const loadThemePromise = loadTheme();

        // await things settling so that any errors we have to render have features like i18n running
        await settled(loadThemePromise, loadLanguagePromise);

        let acceptBrowser = supportedBrowser;
        if (!acceptBrowser && window.localStorage) {
            acceptBrowser = Boolean(window.localStorage.getItem("mx_accepts_unsupported_browser"));
        }

        // ##########################
        // error handling begins here
        // ##########################
        if (!acceptBrowser) {
            await new Promise<void>((resolve) => {
                logger.error("Browser is missing required features.");
                // take to a different landing page to AWOOOOOGA at the user
                showIncompatibleBrowser(() => {
                    if (window.localStorage) {
                        window.localStorage.setItem("mx_accepts_unsupported_browser", String(true));
                    }
                    logger.log("User accepts the compatibility risks.");
                    resolve();
                });
            });
        }

        try {
            // await config here
            await loadConfigPromise;
        } catch (error) {
            // Now that we've loaded the theme (CSS), display the config syntax error if needed.
            if (error instanceof SyntaxError) {
                // This uses the default brand since the app config is unavailable.
                return showError(_t("Your Element is misconfigured"), [
                    _t(
                        "Your Element configuration contains invalid JSON. " +
                            "Please correct the problem and reload the page.",
                    ),
                    _t("The message from the parser is: %(message)s", {
                        message: error.message || _t("Invalid JSON"),
                    }),
                ]);
            }
            return showError(_t("Unable to load config file: please refresh the page to try again."));
        }

        // ##################################
        // app load critical path starts here
        // assert things started successfully
        // ##################################
        await loadOlmPromise;
        await loadModulesPromise;
        await loadThemePromise;
        await loadLanguagePromise;

        // We don't care if the log persistence made it through successfully, but we do want to
        // make sure it had a chance to load before we move on. It's prepared much higher up in
        // the process, making this the first time we check that it did something.
        await settled(persistLogsPromise);

        //:tchap attach handler
        queueOverideUserSettings();

        if (needRefreshForV4) {
            queueClearCacheAndReload();
        }

        registerExpiredAccountListener();
        //end of :tchap:

        // Finally, load the app. All of the other react-sdk imports are in this file which causes the skinner to
        // run on the components.
        await loadApp(fragparts.params);
    } catch (err) {
        logger.error(err);
        // Like the compatibility page, AWOOOOOGA at the user
        // This uses the default brand since the app config is unavailable.
        await showError(_t("Your Element is misconfigured"), [
            extractErrorMessageFromError(err, _t("Unexpected error preparing the app. See console for details.")),
        ]);
    }
}

start().catch((err) => {
    logger.error(err);
    // show the static error in an iframe to not lose any context / console data
    // with some basic styling to make the iframe full page
    document.body.style.removeProperty("height");
    const iframe = document.createElement("iframe");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - typescript seems to only like the IE syntax for iframe sandboxing
    iframe["sandbox"] = "";
    iframe.src = supportedBrowser ? "static/unable-to-load.html" : "static/incompatible-browser.html";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.position = "absolute";
    iframe.style.top = "0";
    iframe.style.left = "0";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.border = "0";
    document.getElementById("matrixchat")?.appendChild(iframe);
});
