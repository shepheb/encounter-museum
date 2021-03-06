
angular.module('encounter')
.run(function($timeout, indexer) {
  $timeout(indexer.loadAll, 2000);
})

.factory('net', function(cache, parse, $http, $q) {
  var inflight = {};
  return {
    fetchTradition: function(tradition) {
      var cached = cache.get(tradition);
      if (cached) {
        return $q.when(cached);
      } else if (inflight[tradition]) {
        return inflight[tradition];
      } else {
        var d = $q.defer();
        inflight[tradition] = d.promise;
        $http({
          method: 'GET',
          url: 'traditions/' + tradition + '.md',
          responseType: 'text'
        }).success(function(data, status) {
          var parsed = parse(data, tradition);
          cache.put(tradition, parsed);
          d.resolve(parsed);
          delete inflight[tradition];
        }).error(function(data, status) {
          // Yes, resolve.
          d.resolve({ description: 'Failed to retrieve content for ' + tradition });
          delete inflight[tradition];
        });

        return d.promise;
      }
    }
  };
})

.factory('cache', function() {
  var content = {};
  return {
    get: function(key) {
      return content[key];
    },
    put: function(key, val) {
      content[key] = val;
    }
  };
})

.factory('markdown', function($window, $sce) {
  var converter = new $window.Showdown.converter();
  return function(text) {
    return text && $sce.trustAsHtml(converter.makeHtml(text).replace('<a href', '<a target="_blank" href'));
  };
})

.factory('parse', function(markdown) {
  // Responsible for reading the file format. The format is as follows:
  // - Markdown description of the tradition.
  // - 0 or more artifact blocks, which have the form:
  //   - A line of ---
  //   - key: value front-matter, including lists as [ foo, bar, baz ]. No quotes.
  //     - Known keys: title, size, date, images (list)
  //   - A line of ---
  //   - Markdown description of the artifact.
  //
  // Returns an object with:
  // - description: HTML. The top-level description of the tradition.
  // - artifacts: Array of objects. Each object is the key-value pairs from the artifact, plus description.
  //   - title: string. The name of the artifact.
  //   - images: Array.<string>. The paths to the images, relative to /assets/:tradition/
  //   - description: string (Markdown, to be parsed on display).
  //   - descriptionHTML: HTML (cache of above)
  //   - Others are optional.
  // - images: Array of objects, with:
  //   - image: Path, relative as above.
  //   - artifact: index into the above artifacts array.

  return function(text, slug) {
    var lines = text.split('\n');
    var obj = {};

    var breakRegex = /^---\s*$/;
    var keyValueRegex = /^\s*([^:\s]+)\s*:\s*(.*?)\s*$/;
    var listRegex = /^\s*\[([^\]]*?)\s*\]\s*$/;
    var imageRegex = /^"([^"]+)"$/;

    var legalChars = "abcdefghijklmnopqrstuvwxyz- ";

    function nextBreak(from) {
      for (var i = from; i < lines.length; i++) {
        if (breakRegex.test(lines[i])) return i;
      }
      return -1;
    }

    var iTop = 0;
    var iBottom = nextBreak(0);

    obj.description = markdown(lines.slice(iTop, iBottom).join('\n'));

    obj.tradition = slug;
    obj.artifacts = [];
    obj.slugMap = {};

    while(iBottom >= 0) {
      iTop = iBottom + 1;
      iBottom = nextBreak(iTop);

      var art = {};

      // Read the front-matter.
      for(var i = iTop; i < iBottom; i++) {
        var m = lines[i].match(keyValueRegex);
        if(m) {
          if (m[1] == 'images') {
            var list = m[2].match(listRegex);
            if (list && list[1]) {
              art.images = list[1].split(',').map(function(x) {
                var y = x.trim();
                var m = y.match(imageRegex);
                return m[1];
              });
            }
          } else if(m[1] && m[2]) {
            art[m[1]] = m[2];
          }
        }
      }

      // Now read the description.
      iTop = iBottom + 1;
      iBottom = nextBreak(iTop);
      art.description = lines.slice(iTop, iBottom).join('\n').trim();

      // Convert the name into a slug that can be used in the URL bar.
      // Drop everything but letters and spaces from the name.
      art.slug = art.title.toLowerCase().trim().split('').filter(function(c) {
        return legalChars.indexOf(c) >= 0;
      }).map(function(c) {
        return c == ' ' ? '-' : c;
      }).join('');

      if (!obj.slugMap[art.slug]) {
        // obj.slugMap['foo'] points at the globalIndex of that artifact.
        obj.slugMap[art.slug] = obj.artifacts.length;
      }

      if (art.images && art.images.length) {
        obj.artifacts.push(art);
      } else {
        console.warn('Artifact without images', art);
      }
    }

    return obj;
  };
})

.factory('indexer', function(net, traditions, $q) {
  var cached = {};

  return {
    loadAll: function() {
      // Fetch all the traditions and index their contents.
      var promises = Object.keys(traditions).map(function(t) {
        return net.fetchTradition(traditions[t].slug);
      });

      // We want these to run gradually so they don't tank the UI.
      // Therefore we do them serially.
      // TODO: Is this a performance bottleneck? It might be better to fire them all
      // at once and let the browser sort them out.

      promises.reduce(function(soFar, p) {
        return soFar.then(function() {
          return p.then(function(obj) {
            if (obj && obj.artifacts)
              cached[obj.tradition] = obj.artifacts;
          });
        });
      }, $q.when());
    },

    lookup: function(str) {
      // Look through each tradition, and through each artifact, looking for strings that match the title case-insensitively.
      var re = new RegExp(str, 'i');
      var matches = {};
      Object.keys(traditions).forEach(function(t) {
        var out = [];
        var artifacts = cached[t];
        for (var i = 0; i < artifacts.length; i++) {
          if (artifacts[i].title.match(re)) {
            artifacts[i].traditionSlug = t;
            artifacts[i].tradition = traditions[t].name;
            out.push(artifacts[i]);
          }
          if (out.length >= 10) {
            matches[t] = out;
            return;
          }
        }
        matches[t] = out;
      });

      // Now we take the first 10 in a round-robin way.
      var out = [];
      var index = 0;
      var slugs = Object.keys(traditions);
      while(slugs.length > 0 && out.length < 10) {
        var m = matches[slugs[index]];
        if (m && m.length > 0) {
          out.push(m.shift());
          index = (index + 1) % slugs.length;
        } else { // No matches, so splice out this tradition.
          slugs.splice(index, 1);
          index = index % slugs.length; // Make sure index is still inside the array.
        }
      }
      return out;
    }
  };
});

