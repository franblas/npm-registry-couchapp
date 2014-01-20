module.exports = function (doc, oldDoc, user, dbCtx) {
  function assert (ok, message) {
    if (!ok) throw {forbidden:message}
  }

  // can't write to the db without logging in.
  if (!user || !user.name) {
    throw { forbidden: "Please log in before writing to the db" }
  }

  try {
    require("monkeypatch").patch(Object, Date, Array, String)
  } catch (er) {
    assert(false, "failed monkeypatching")
  }

  try {
    var semver = require("semver")
    var valid = require("valid")
    var deep = require("deep")
    var deepEquals = deep.deepEquals
  } catch (er) {
    assert(false, "failed loading modules")
  }

  try {
    if (oldDoc) oldDoc.users = oldDoc.users || {}
    doc.users = doc.users || {}
  } catch (er) {
    assert(false, "failed checking users")
  }


  // admins can do ANYTHING (even break stuff)
  try {
    if (isAdmin()) return
  } catch (er) {
    assert(false, "failed checking admin-ness")
  }

  // figure out what changed in the doc.
  function diffObj (o, n, p) {
    p = p || ""
    var d = []
    var seenKeys = []

    for (var i in o) {
      seenKeys.push(i)
      if (n[i] === undefined) {
        d.push("Deleted: "+p+i)
      }
      else if (typeof o[i] !== typeof n[i]) {
        d.push("Changed Type: "+p+i)
      }
      else if (typeof o[i] === "object") {
        if (o[i]) {
          if (n[i]) {
            d = d.concat(diffObj(o[i], n[i], p + i + "."))
          } else {
            d.push("Nulled: "+p+i)
          }
        } else {
          if (n[i]) {
            d.push("Un-nulled: "+p+i)
          } else {
            // they're both null, and thus equal.  do nothing.
          }
        }
      }
      // non-object, non-null
      else if (o[i] !== n[i]) {
          d.push("Changed: "+p+i+" "+JSON.stringify(o[i]) + " -> "
                 +JSON.stringify(n[i]))
      }
    }

    for (var i in n) {
      if (-1 === seenKeys.indexOf(i)) {
        d.push("Added: "+p+i)
      }
    }
    return d
  }

  // if the doc is an {error:"blerg"}, then throw that right out.
  // something detected in the _updates/package script.
  // XXX: Make this not ever happen ever.  Validation belongs here,
  // not in the update function.
  try {
    assert(!doc.forbidden || doc._deleted, doc.forbidden)
  } catch (er) {
    assert(false, "failed checking doc.forbidden or doc._deleted")
  }

  // everyone may alter his "starred" status on any package
  try {
    if (oldDoc &&
        !doc._deleted &&
        deepEquals(doc, oldDoc,
                   [["users", user.name], ["time", "modified"]])) {
      return
    }
  } catch (er) {
    assert(false, "failed checking starred stuff")
  }


  // check if the user is allowed to write to this package.
  function validUser () {
    if ( !oldDoc || !oldDoc.maintainers ) return true
    if (isAdmin()) return true
    if (typeof oldDoc.maintainers !== "object") return true
    for (var i = 0, l = oldDoc.maintainers.length; i < l; i ++) {
      if (oldDoc.maintainers[i].name === user.name) return true
    }
    return false
  }

  function isAdmin () {
    if (dbCtx &&
        dbCtx.admins) {
      if (dbCtx.admins.names &&
          dbCtx.admins.roles &&
          dbCtx.admins.names.indexOf(user.name) !== -1) return true
      for (var i=0;i<user.roles.length;i++) {
        if (dbCtx.admins.roles.indexOf(user.roles[i]) !== -1) return true
      }
    }
    return user && user.roles.indexOf("_admin") >= 0
  }

  try {
    var vu = validUser()
  } catch (er) {
    assert(false, "problem checking user validity");
  }

  if (!vu) {
    assert(vu, "user: " + user.name + " not authorized to modify "
                        + oldDoc.name + "\n"
                        + diffObj(oldDoc, doc).join("\n"))
  }

  // you may not delete the npm document!
  if (doc._deleted && doc.name === "npm")
    throw { forbidden: "you may not delete npm!" }

  // deleting a document entirely *is* allowed.
  if (doc._deleted) return

  // sanity checks.
  assert(valid.name(doc.name), "name invalid: "+doc.name)

  // New documents may only be created with all lowercase names.
  // At some point, existing docs will be migrated to lowercase names
  // as well.
  if (!oldDoc && doc.name !== doc.name.toLowerCase()) {
    assert(false, "New packages must have all-lowercase names")
  }

  assert(doc.name === doc._id, "name must match _id")
  assert(doc.name.length < 512, "name is too long")
  assert(!doc.mtime, "doc.mtime is deprecated")
  assert(!doc.ctime, "doc.ctime is deprecated")
  assert(typeof doc.time === "object", "time must be object")

  assert(typeof doc["dist-tags"] === "object", "dist-tags must be object")

  var versions = doc.versions
  assert(typeof versions === "object", "versions must be object")

  var latest = doc["dist-tags"].latest
  if (latest) {
    assert(versions[latest], "dist-tags.latest must be valid version")
  }

  // the 'latest' version must have a dist and shasum
  // I'd like to also require this of all past versions, but that
  // means going back and cleaning up about 2000 old package versions,
  // or else *new* versions of those packages can't be published.
  // Until that time, do this instead:
  var version = versions[latest]
  if (version) {
    if (!version.dist)
      assert(false, "no dist object in " + latest + " version")
    if (!version.dist.tarball)
      assert(false, "no tarball in " + latest + " version")
    if (!version.dist.shasum)
      assert(false, "no shasum in " + latest + " version")
  }

  for (var v in doc["dist-tags"]) {
    var ver = doc["dist-tags"][v]
    assert(semver.valid(ver, true),
           v + " version invalid version: " + ver)
    assert(versions[ver],
           v + " version missing: " + ver)
  }

  var depCount = 0
  var maxDeps = 1000
  function ridiculousDeps() {
    if (++depCount > maxDeps)
      assert(false, "too many deps.  please be less ridiculous.")
  }
  for (var ver in versions) {
    var version = versions[ver]
    assert(semver.valid(ver, true),
           "invalid version: " + ver)
    assert(typeof version === "object",
           "version entries must be objects")
    assert(version.version === ver,
           "version must match: "+ver)
    assert(version.name === doc._id,
           "version "+ver+" has incorrect name: "+version.name)

    depCount = 0
    for (var dep in version.dependencies || {}) ridiculousDeps()
    for (var dep in version.devDependencies || {}) ridiculousDeps()
    for (var dep in version.optionalDependencies || {}) ridiculousDeps()

    // NEW versions must only have strings in the 'scripts' field,
    // and versions that are strictly valid semver 2.0
    if (oldDoc && oldDoc.versions && !oldDoc.versions[ver]) {
      assert(semver.valid(ver), "Invalid SemVer 2.0 version: " + ver)
      if (version.hasOwnProperty('scripts')) {
        assert(version.scripts && typeof version.scripts === "object",
               "'scripts' field must be an object")
        for (var s in version.scripts) {
          assert(typeof version.scripts[s] === "string",
                 "Non-string script field: " + s)
        }
      }
    }
  }

  assert(Array.isArray(doc.maintainers),
         "maintainers should be a list of owners")
  doc.maintainers.forEach(function (m) {
    assert(m.name && m.email,
           "Maintainer should have name and email: " + JSON.stringify(m))
  })

  var time = doc.time
  var c = new Date(Date.parse(time.created))
    , m = new Date(Date.parse(time.modified))
  assert(c.toString() !== "Invalid Date",
         "invalid created time: " + JSON.stringify(time.created))

  assert(m.toString() !== "Invalid Date",
         "invalid modified time: " + JSON.stringify(time.modified))

  if (oldDoc &&
      oldDoc.time &&
      oldDoc.time.created &&
      Date.parse(oldDoc.time.created)) {
    assert(Date.parse(oldDoc.time.created) === Date.parse(time.created),
           "created time cannot be changed")
  }

  if (oldDoc && oldDoc.users) {
    assert(deepEquals(doc.users,
                      oldDoc.users, [[user.name]]),
           "you may only alter your own 'star' setting")
  }

  if (doc.url) {
    assert(false,
           "Package redirection has been removed. "+
           "Please update your publish scripts.")
  }

  if (doc.description) {
    assert(typeof doc.description === 'string',
           '"description" field must be a string')
  }

  // at this point, we've passed the basic sanity tests.
  // Time to dig into more details.
  // Valid operations:
  // 1. Add a version
  // 2. Remove a version
  // 3. Modify a version
  // 4. Add or remove onesself from the "users" hash (already done)
  //
  // If a version is being added or changed, make sure that the
  // _npmUser field matches the current user, and that the
  // time object has the proper entry, and that the "maintainers"
  // matches the current "maintainers" field.
  //
  // Things that must not change:
  //
  // 1. More than one version being modified.
  // 2. Removing keys from the "time" hash
  //
  // Later, once we are off of the update function 3-stage approach,
  // these things should also be errors:
  //
  // 1. Lacking an attachment for any published version.
  // 2. Having an attachment for any version not published.

  var oldVersions = oldDoc ? oldDoc.versions || {} : {}
  var oldTime = oldDoc ? oldDoc.time || {} : {}

  var versions = Object.keys(doc.versions || {})
    , modified = null
    , allowedChange = [["directories"], ["deprecated"]]

  for (var i = 0, l = versions.length; i < l; i ++) {
    var v = versions[i]
    if (!v) continue
    assert(doc.time[v], "must have time entry for "+v)

    // new npm's "fix" the version
    // but that makes it look like it's been changed.
    if (doc && doc.versions[v] && oldDoc && oldDoc.versions[v])
      doc.versions[v].version = oldDoc.versions[v].version

    if (doc.versions[v] && oldDoc && oldDoc.versions[v] &&
        !deepEquals(doc.versions[v], oldVersions[v], allowedChange)) {
      // this one was modified
      // if it's more than a few minutes off, then something is wrong.
      var t = Date.parse(doc.time[v])
        , n = Date.now()
      // assert(doc.time[v] !== oldTime[v] &&
      //        Math.abs(n - t) < 1000 * 60 * 60,
      //        v + " time needs to be updated\n" +
      //        "new=" + JSON.stringify(doc.versions[v]) + "\n" +
      //        "old=" + JSON.stringify(oldVersions[v]))

      // var mt = Date.parse(doc.time.modified).getTime()
      //   , vt = t.getTime()
      // assert(Math.abs(mt - vt) < 1000 * 60 * 60,
      //        v + " is modified, should match modified time")

      // XXX Remove the guard these once old docs have been found and
      // fixed.  It's too big of a pain to have to manually fix
      // each one every time someone complains.
      if (typeof doc.versions[v]._npmUser !== "object") continue


      assert(typeof doc.versions[v]._npmUser === "object",
             "_npmUser field must be object\n"+
             "(You probably need to upgrade your npm version)")

      var _npmUser = doc.versions[v]._npmUser
      assert(_npmUser.name === user.name,
             "version=" + v + "\n" +
             "user.name=" + user.name + "\n" +
             "_npmUser.name=" + _npmUser.name + "\n" +
             //"new=" + JSON.stringify(doc.versions[v]) + "\n" +
             //"old=" + JSON.stringify(oldVersions[v]) + "\n" +
             "_npmUser.name must === user.name")

      // function names (maintainers) {
      //   return maintainers.map(function(m) {
      //     return m.name
      //   }).sort()
      // }

      // assert(deepEquals(names(doc.versions[v].maintainers),
      //                   names(doc.maintainers)),
      //        "modified version " + v + " 'maintainers' must === doc.maintainers\n" +
      //        "expected: " + JSON.stringify(doc.maintainers) + "\n" +
      //        "actual:   " + JSON.stringify(doc.versions[v].maintainers))

      // make sure that the _npmUser is one of the maintainers
      var found = false
      for (var j = 0, lm = doc.maintainers.length; j < lm; j ++) {
        var m = doc.maintainers[j]
        if (m.name === doc.versions[v]._npmUser.name) {
          found = true
          break
        }
      }
      assert(found, "_npmUser must be a current maintainer.\n"+
                    "maintainers=" + JSON.stringify(doc.maintainers)+"\n"+
                    "current user=" + JSON.stringify(doc.versions[v]._npmUser))

    } else if (oldTime[v]) {
      assert(oldTime[v] === doc.time[v],
             v + " time should not be modified 1")
    }
  }

  // now go through all the time settings that weren't covered
  for (var v in oldTime) {
    if (doc.versions[v] || !oldVersions[v]) continue
    assert(doc.time[v] === oldTime[v],
           v + " time should not be modified 2")
  }

}

