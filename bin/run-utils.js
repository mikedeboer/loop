/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* eslint-env node */

var Extend = require("lodash").extend;
var Fs = require("fs-promise");
var FxProfileFinder = require("firefox-profile/lib/profile_finder");
var FxRunner = require("fx-runner/lib/run");
var Path = require("path");
var When = require("when");

/**
 * Profiles that do not include "/" are treated as profile names to be used by
 * the Fx Profile Manager.
 *
 * @param {String} profile Name of the profile to test
 * @return {Boolean}
 */
function isProfileName(profile) {
  if (!profile) {
    return false;
  }
  return !/[\\\/]/.test(profile);
}

/**
 * Retrieve the valid path of a profile.
 *
 * @param  {String}  profile Name or path of the profile
 * @return {Promise} Will be resolved with a valid absolute path pointing to the
 *                   profile or rejected when the path does not exist or when the
 *                   profile name can not be found.
 */
function getProfilePath(profile) {
  if (isProfileName(profile)) {
    var finder = new FxProfileFinder();
    return When.promise(function(resolve, reject) {
      finder.getPath(profile, function(err, path) {
        if (err) {
          reject(err);
          return;
        }

        resolve(path);
      });
    });
  }

  return When.promise(function(resolve, reject) {
    profile = Path.normalize(profile);
    if (!Path.isAbsolute(profile)) {
      profile = Path.join(process.cwd(), profile);
    }
    Fs.stat(profile).then(function(stat) {
      if (!stat.isDirectory()) {
        reject("Profile path '" + profile + "' is not a directory");
        return;
      }
      resolve(profile);
    }).catch(reject);
  });
}
exports.getProfilePath = getProfilePath;

// Environment variables that make sure that all messages and errors end up in
// the process stdout or stderr streams.
var FX_ENV = {
  "XPCOM_DEBUG_BREAK": "stack",
  "NS_TRACE_MALLOC_DISABLE_STACKS": "1"
};

/**
 * Check a chunk of process output to check if it contains an error message.
 *
 * @param  {String} line
 * @return {Boolean}
 */
function isErrorString(line) {
  return /^\*{25}/.test(line) || /^\s*Message: [\D]*Error/.test(line);
}

var GARBAGE = [
  /\[JavaScript Warning: "TypeError: "[\w\d]+" is read-only"\]/,
  /JavaScript strict warning: /,
  /\#\#\#\!\!\! \[Child\]\[DispatchAsyncMessage\]/
];

/**
 * Checks of the chunk of process output can be discarded. The patterns that are
 * tested against can be found in the `GARBAGE` array above.
 *
 * @param  {String} data
 * @return {Boolean}
 */
function isGarbage(data) {
  if (!data || !data.replace(/[\s\t\r\n]+/, "")) {
    return true;
  }
  for (var i = 0, l = GARBAGE.length; i < l; ++i) {
    if (GARBAGE[i].test(data)) {
      return true;
    }
  }
  return false;
}

/**
 * Output a chunk of process output to the console (Terminal).
 *
 * @param {String} data
 * @param {String} type Type of output; can be 'log' (default), 'warn' or 'error'
 */
function writeLog(data, type) {
  if (isGarbage(data)) {
    return;
  }
  process[(type === "error") ? "stderr" : "stdout"].write(data);
}

/**
 * Takes options, and runs Firefox. Inspiration of this code can be found at
 * https://github.com/mozilla-jetpack/jpm.
 *
 * @param {Object} options
 *   - `binary` path to Firefox binary to use
 *   - `profile` path to profile or profile name to use
 *   - `binaryArgs` binary arguments Array to pass into Firefox
 * @return {Promise}
 */
function runFirefox(options) {
  return When.promise(function(resolve, reject) {
    options = options || {};

    FxRunner({
      "binary": options.binary,
      "foreground": ("foreground" in options) ? options.foreground : true,
      "profile": options.profile,
      env: Extend({}, process.env, FX_ENV),
      verbose: true,
      "binary-args": options.binaryArgs
    }).then(function(results) {
      var firefox = results.process;

      console.log("Executing Firefox binary: " + results.binary);
      console.log("Executing Firefox with args: " + results.args);

      firefox.on("error", function(err) {
        if (/No such file/.test(err) || err.code === "ENOENT") {
          console.error("No Firefox binary found at " + results.binary);
          if (!options.binary) {
            console.error("Specify a Firefox binary to use with the `-b` flag.");
          }
        } else {
          console.error(err);
        }
        reject(err);
      });

      firefox.on("close", resolve);

      firefox.stderr.setEncoding("utf8");
      firefox.stderr.on("data", function(data) {
        if (/^\s*System JS : WARNING/.test(data)) {
          writeLog(data, "warn");
        } else {
          writeLog(data, "error");
        }
      });

      // Many errors in addons are printed to stdout instead of stderr;
      // we should check for errors here and print them out.
      firefox.stdout.setEncoding("utf8");
      firefox.stdout.on("data", function(data) {
        if (isErrorString(data)) {
          writeLog(data, "error");
        } else {
          writeLog(data);
        }
      });
    });
  });
}
exports.runFirefox = runFirefox;

var currentSample = null;
var currentSampleMap = null;
var prefsRE = /^user_pref\(['"](.*)["'],\s*['"]?(.*)["']?\)/;

function parsePrefValue(value) {
  if (/^[\d]+$/.test(value)) {
    return parseInt(value, 10);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function takePrefsSample(profilePath) {
  currentSample = [];
  currentSampleMap = {};

  return When.promise(function(resolve, reject) {
    var prefsFile = Path.join(profilePath, "user.js");
    Fs.exists(prefsFile).then(function(exists) {
      if (!exists) {
        resolve();
        return;
      }

      Fs.readFile(prefsFile, "utf8").then(function(content) {
        currentSample = content.split("\n").map(function(line) {
          var found = line.match(prefsRE);
          if (found) {
            var prefName = found[1];
            var prefValue = parsePrefValue(found[2]);

            // Check for JSON values:
            var parts = prefName.split(/['"],\s*['"]/);
            if (parts.length > 1) {
              prefName = parts.shift();
              prefValue = parts.join("\",\"") + prefValue;
            }

            currentSampleMap[prefName] = prefValue;
            // Sample the name only, to be able to reference it later when we
            // write the preferences back to file.
            return prefName;
          }
          return line;
        });

        // Clear trailing empty lines.
        var lastLine = currentSample.pop();
        while (!lastLine.replace(/^[\s\n\t\r]+$/, "")) {
          lastLine = currentSample.pop();
        }
        if (lastLine) {
          currentSample.push(lastLine);
        }

        resolve();
      }).catch(reject);
    });
  });
}

function prefValueToString(val) {
  switch (typeof val) {
    case "boolean":
      return val ? "true" : "false";
    case "number":
      return "" + val;
    case "string":
      return "\"" + val.replace(/[^\\]{0}"/g, "\\\"") + "\"";
    default:
      return val;
  }
}

function getUserPrefLine(name, value) {
  return "user_pref(\"" + name + "\", " + prefValueToString(value) + ");";
}

function writeUserPrefs(profilePath, userPrefs) {
  if (!userPrefs) {
    userPrefs = currentSample || [];
  }

  var prefsFile = Path.join(profilePath, "user.js");
  return Fs.writeFile(prefsFile, userPrefs.join("\n") + "\n", "utf8");
}

function setUserPrefs(profilePath, prefs) {
  return takePrefsSample(profilePath)
    .then(function() {
      var seen = {};
      var userPrefs = currentSample.map(function(entry) {
        if (entry in currentSampleMap) {
          // We encountered a line containing a pref.
          var prefValue = currentSampleMap[entry];
          if (entry in prefs) {
            // This line of the prefs needs to be overwritten.
            prefValue = prefs[entry];
            seen[entry] = 1;
          }

          return getUserPrefLine(entry, prefValue);
        }

        return entry;
      });

      Object.getOwnPropertyNames(prefs).forEach(function(entry) {
        if (seen[entry]) {
          // An existing pref line has been overwritten above.
          return;
        }

        userPrefs.push(getUserPrefLine(entry, prefs[entry]));
      });

      return writeUserPrefs(profilePath, userPrefs);
    });
}

exports.setUserPrefs = setUserPrefs;

function restoreUserPrefs(profilePath) {
  return writeUserPrefs(profilePath);
}

exports.restoreUserPrefs = restoreUserPrefs;

var DEFAULT_PREFS = {
  "browser.displayedE10SNotice": 4,
  "browser.EULA.override": true,
  "browser.EULA.3.accepted": true,
  "browser.shell.skipDefaultBrowserCheck": true,
  "general.warnOnAboutConfig": false,
  "security.fileuri.origin_policy": 3,
  "security.fileuri.strict_origin_policy": false,
  "security.warn_entering_secure": false,
  "security.warn_entering_secure.show_once": false,
  "security.warn_entering_weak": false,
  "security.warn_entering_weak.show_once": false,
  "security.warn_leaving_secure": false,
  "security.warn_leaving_secure.show_once": false,
  "security.warn_submit_insecure": false,
  "security.warn_viewing_mixed": false,
  "security.warn_viewing_mixed.show_once": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false
};

/**
 * Run Firefox to create a fresh, empty profile and resolve the promise with the
 * resulting path to that profile.
 *
 * @param {Object} options
 *   - `binary` path to Firefox binary to use
 *   - `profile` path to profile or profile name to use
 *   - `binaryArgs` binary arguments Array to pass into Firefox
 * @return {Promise}
 */
function createEmptyProfile(options) {
  return When.promise(function(resolve, reject) {
    var profilePath;
    // Make sure we don't mutate the options object here.
    options = Object.create(options);
    var profile = options.profile;
    // Unset the profile to run the browser with, because we don't need it.
    options.profile = null;
    // Magic command line argument that will yield a fresh profile.
    options.binaryArgs = ["-CreateProfile", profile];
    options.foreground = false;
    return runFirefox(options)
      .then(function() {
        return getProfilePath(profile);
      })
      .then(function(path) {
        profilePath = path;
        // Put the userprefs in there.
        return setUserPrefs(profilePath, DEFAULT_PREFS);
      })
      .then(function() {
        resolve(profilePath);
      })
      .catch(reject);
  });
}

exports.createEmptyProfile = createEmptyProfile;
