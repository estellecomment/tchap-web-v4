#!/usr/bin/env node

const loaderUtils = require("loader-utils");

// copies the resources into the webapp directory.
//

// Languages are listed manually so we can choose when to include
// a translation in the app (because having a translation with only
// 3 strings translated is just frustrating)
// This could readily be automated, but it's nice to explicitly
// control when new languages are available.
const INCLUDE_LANGS = [
    { value: "en_EN", label: "English" },
    { value: "en_US", label: "English (US)" },
    { value: "fr", label: "Français" },
];

// cpx includes globbed parts of the filename in the destination, but excludes
// common parents. Hence, "res/{a,b}/**": the output will be "dest/a/..." and
// "dest/b/...".
const COPY_LIST = [
    ["res/apple-app-site-association", "webapp"],
    ["res/manifest.json", "webapp"],
    ["res/sw.js", "webapp"],
    ["res/welcome.html", "webapp"],
    ["res/welcome/**", "webapp/welcome"],
    ["res/themes/**", "webapp/themes"],
    ["res/vector-icons/**", "webapp/vector-icons"],
    ["res/decoder-ring/**", "webapp/decoder-ring"],
    ["node_modules/matrix-react-sdk/res/media/**", "webapp/media"],
    ["node_modules/@matrix-org/olm/olm_legacy.js", "webapp", { directwatch: 1 }],
    ["./config.json", "webapp", { directwatch: 1 }],
    ["contribute.json", "webapp"],
    // :TCHAP: copy tchap-specific translations to the translations dir, ready to be served. See custom_translations_url in config.json.
    ["src/tchap/i18n/strings/tchap_translations.json", "webapp/i18n"],
];

const parseArgs = require("minimist");
const Cpx = require("cpx");
const chokidar = require("chokidar");
const fs = require("fs");
const rimraf = require("rimraf");

const argv = parseArgs(process.argv.slice(2), {});

const watch = argv.w;
const verbose = argv.v;

function errCheck(err) {
    if (err) {
        console.error(err.message);
        process.exit(1);
    }
}

// Check if webapp exists
if (!fs.existsSync("webapp")) {
    fs.mkdirSync("webapp");
}
// Check if i18n exists
if (!fs.existsSync("webapp/i18n/")) {
    fs.mkdirSync("webapp/i18n/");
}

function next(i, err) {
    errCheck(err);

    if (i >= COPY_LIST.length) {
        return;
    }

    const ent = COPY_LIST[i];
    const source = ent[0];
    const dest = ent[1];
    const opts = ent[2] || {};
    let cpx = undefined;

    if (!opts.lang) {
        cpx = new Cpx.Cpx(source, dest);
    }

    if (verbose && cpx) {
        cpx.on("copy", (event) => {
            console.log(`Copied: ${event.srcPath} --> ${event.dstPath}`);
        });
        cpx.on("remove", (event) => {
            console.log(`Removed: ${event.path}`);
        });
    }

    const cb = (err) => {
        next(i + 1, err);
    };

    if (watch) {
        if (opts.directwatch) {
            // cpx -w creates a watcher for the parent of any files specified,
            // which in the case of config.json is '.', which inevitably takes
            // ages to crawl. So we create our own watcher on the files
            // instead.
            const copy = () => {
                cpx.copy(errCheck);
            };
            chokidar.watch(source).on("add", copy).on("change", copy).on("ready", cb).on("error", errCheck);
        } else {
            cpx.on("watch-ready", cb);
            cpx.on("watch-error", cb);
            cpx.watch();
        }
    } else {
        cpx.copy(cb);
    }
}

function genLangFile(lang, dest) {
    const reactSdkFile = "node_modules/matrix-react-sdk/src/i18n/strings/" + lang + ".json";
    const riotWebFile = "src/i18n/strings/" + lang + ".json";

    let translations = {};
    [reactSdkFile, riotWebFile].forEach(function (f) {
        if (fs.existsSync(f)) {
            try {
                Object.assign(translations, JSON.parse(fs.readFileSync(f).toString()));
            } catch (e) {
                console.error("Failed: " + f, e);
                throw e;
            }
        }
    });

    translations = weblateToCounterpart(translations);

    const json = JSON.stringify(translations, null, 4);
    const jsonBuffer = Buffer.from(json);
    const digest = loaderUtils.getHashDigest(jsonBuffer, null, null, 7);
    const filename = `${lang}.${digest}.json`;

    fs.writeFileSync(dest + filename, json);
    if (verbose) {
        console.log("Generated language file: " + filename);
    }

    return filename;
}

function genLangList(langFileMap) {
    const languages = {};
    INCLUDE_LANGS.forEach(function (lang) {
        const normalizedLanguage = lang.value.toLowerCase().replace("_", "-");
        const languageParts = normalizedLanguage.split("-");
        if (languageParts.length == 2 && languageParts[0] == languageParts[1]) {
            languages[languageParts[0]] = { fileName: langFileMap[lang.value], label: lang.label };
        } else {
            languages[normalizedLanguage] = { fileName: langFileMap[lang.value], label: lang.label };
        }
    });
    fs.writeFile("webapp/i18n/languages.json", JSON.stringify(languages, null, 4), function (err) {
        if (err) {
            console.error("Copy Error occured: " + err);
            throw new Error("Failed to generate languages.json");
        }
    });
    if (verbose) {
        console.log("Generated languages.json");
    }
}

/**
 * Convert translation key from weblate format
 * (which only supports a single level) to counterpart
 * which requires object values for 'count' translations.
 *
 * eg.
 *     "there are %(count)s badgers|one": "a badger",
 *     "there are %(count)s badgers|other": "%(count)s badgers"
 *   becomes
 *     "there are %(count)s badgers": {
 *         "one": "a badger",
 *         "other": "%(count)s badgers"
 *     }
 */
function weblateToCounterpart(inTrs) {
    const outTrs = {};

    for (const key of Object.keys(inTrs)) {
        const keyParts = key.split("|", 2);
        if (keyParts.length === 2) {
            let obj = outTrs[keyParts[0]];
            if (obj === undefined) {
                obj = outTrs[keyParts[0]] = {};
            } else if (typeof obj === "string") {
                // This is a transitional edge case if a string went from singular to pluralised and both still remain
                // in the translation json file. Use the singular translation as `other` and merge pluralisation atop.
                obj = outTrs[keyParts[0]] = {
                    other: inTrs[key],
                };
                console.warn("Found entry in i18n file in both singular and pluralised form", keyParts[0]);
            }
            obj[keyParts[1]] = inTrs[key];
        } else {
            outTrs[key] = inTrs[key];
        }
    }

    return outTrs;
}

/**
watch the input files for a given language,
regenerate the file, adding its content-hashed filename to langFileMap
and regenerating languages.json with the new filename
*/
function watchLanguage(lang, dest, langFileMap) {
    const reactSdkFile = "node_modules/matrix-react-sdk/src/i18n/strings/" + lang + ".json";
    const riotWebFile = "src/i18n/strings/" + lang + ".json";

    // XXX: Use a debounce because for some reason if we read the language
    // file immediately after the FS event is received, the file contents
    // appears empty. Possibly https://github.com/nodejs/node/issues/6112
    let makeLangDebouncer;
    const makeLang = () => {
        if (makeLangDebouncer) {
            clearTimeout(makeLangDebouncer);
        }
        makeLangDebouncer = setTimeout(() => {
            const filename = genLangFile(lang, dest);
            langFileMap[lang] = filename;
            genLangList(langFileMap);
        }, 500);
    };

    [reactSdkFile, riotWebFile].forEach(function (f) {
        chokidar.watch(f).on("add", makeLang).on("change", makeLang).on("error", errCheck);
    });
}

// language resources
const I18N_DEST = "webapp/i18n/";
const I18N_FILENAME_MAP = INCLUDE_LANGS.reduce((m, l) => {
    const filename = genLangFile(l.value, I18N_DEST);
    m[l.value] = filename;
    return m;
}, {});
genLangList(I18N_FILENAME_MAP);

if (watch) {
    INCLUDE_LANGS.forEach((l) => watchLanguage(l.value, I18N_DEST, I18N_FILENAME_MAP));
}

// non-language resources
next(0);
