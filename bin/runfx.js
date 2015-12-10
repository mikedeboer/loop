#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* eslint-env node */

var Commander = require("commander");
var Fs = require("fs-promise");
var Path = require("path");
var Rimraf = require("rimraf");
var Util = require("./run-utils");
var Version = require("../package.json").version;
var When = require("when");

var DEFAULT_PROFILE = "loop-dev";

Commander
  .version(Version)
  .option("-b, --binary <path>", "Path of Firefox binary to use.")
  .option("-p, --profile <path>", "Path or name of Firefox profile to use.")
  .option("--binary-args <CMDARGS>", "Pass additional arguments into Firefox.")
  .parse(process.argv);

function ensureRemoved(path) {
  return When.promise(function(resolve, reject) {
    Fs.lstat(path).then(function(targetStat) {
      if (targetStat.isDirectory()) {
        Rimraf(path, function(err) {
          if (err) {
            reject("Removing add-on directory '" + path + "' failed " + err);
            return;
          }

          resolve();
        });
      } else {
        // Removing old symlink or file.
        Fs.unlink(path).then(resolve).catch(reject);
      }
    }).catch(resolve);
  });
}

var addonSourceDir = Path.normalize(Path.join(__dirname, "..", "built", "add-on"));
Fs.stat(addonSourceDir).then(function(sourceStat) {
  if (!sourceStat.isDirectory()) {
    throw "Not a directory";
  }

  // Add-on directory exists, so now we can create the symlink in the profile
  // directory and run Firefox.
  var profile = Commander.profile || DEFAULT_PROFILE;

  Util.getProfilePath(profile).then(function(profilePath) {
    // Since we've got the profile path now, we can create the symlink in the
    // profile directory IF it doesn't exist yet.
    var addonTargetDir = Path.join(profilePath, "extensions", "loop@mozilla.org");
    return ensureRemoved(addonTargetDir).then(function() {
      // This should fail at a certain point, because we don't want the add-on
      // directory to exist.
      return Fs.symlink(addonSourceDir, addonTargetDir).then(function() {
        console.log("Symlinked add-on at '" + addonTargetDir + "'");

        // Add-on should be in the correct place, so now we can run Firefox.
        return Util.runFirefox(Commander).then(function() {
          throw "Firefox terminated properly";
        }).catch(function() {
          console.log("Removing symlink");
          Fs.unlink(addonTargetDir);
        });
      });
    }).catch(function(err) {
      console.error(err);
      process.exit(1);
    });
  }).catch(function() {
    // No valid profile path found, so bail out.
    console.error("ERROR! Could not find a suitable profile. Please create a new profile '" +
      profile + "' and re-run this script.");
    process.exit(1);
  });
}).catch(function(err) {
  console.error(err.message || err);
  console.error("ERROR! Please run `make build` first!");
  process.exit(1);
});
