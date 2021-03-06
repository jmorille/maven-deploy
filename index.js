var fs = require('fs');
var path = require('path');
var walk = require('fs-walk');
var JSZip = require('jszip');
var extend = require('util-extend');
var exec = require('child_process').exec;
var defineOpts = require('define-options');
var semver = require('semver');
var isBinaryFileSync = require('isbinaryfile');

var pkg, validateConfig, validateRepos, validateRepo, userConfig;

const DEFAULT_CONFIG = {
    artifactId: '{name}',
    buildDir: 'dist',
    finalName: '{name}',
    type: 'war',
    fileEncoding: 'utf-8'
};

validateConfig = defineOpts({
    groupId       : 'string   - the Maven group id.',
    artifactId    : '?|string - the Maven artifact id. default "' + DEFAULT_CONFIG.artifactId + '".',
    classifier    : '?|string - the Maven optional classifier.',
    buildDir      : '?|string - build directory. default "' + DEFAULT_CONFIG.buildDir + '".',
    finalName     : '?|string - the final name of the file created when the built project is packaged. default "' +
                    DEFAULT_CONFIG.finalName + '"',
    type          : '?|string - "jar" or "war". default "' + DEFAULT_CONFIG.type + '".',
    fileEncoding  : '?|string - valid file encoding. default "' + DEFAULT_CONFIG.fileEncoding + '"'
});

validateRepos = defineOpts({
    repositories  : 'object[] - array of repositories, each with id and url to a Maven repository'
});

validateRepo = defineOpts({
    id            : 'string   - the Maven repository id',
    url           : 'string   - URL to the Maven repository'
});

function readPackageJSON (encoding) {
    return JSON.parse(fs.readFileSync('package.json', encoding));
}

function filterConfig (configTmpl, pkg) {
    // create a config object from the config template
    // replace {key} with the key's value in package.json
    var obj = extend({}, configTmpl);
    Object.keys(obj).forEach(function (key) {
        var value = obj[key];
        if (typeof value != 'string') { return; }

        obj[key] = value.replace(/{([^}]+)}/g, function (org, key) {
            if (pkg[key] === undefined) { return org; }
            return pkg[key];
        });
    });

    return obj;
}

function archivePath () {
    var conf = getConfig();
    return path.join(conf.buildDir, conf.finalName + '.' + conf.type);
}

function mvnArgs (repoId, isSnapshot) {
    var conf = getConfig();
    var args = {
        packaging    : conf.type,
        file         : archivePath(),
        groupId      : conf.groupId,
        artifactId   : conf.artifactId,
        version      : pkg.version
    };
    if (conf.classifier) {
        args.classifier = conf.classifier;
    }
    if (repoId) {
        var repos = conf.repositories, l = repos.length;
        for (var i=0; i<l; i++) {
            if (repos[i].id !== repoId) { continue; }
            args.repositoryId = repos[i].id;
            args.url          = repos[i].url;
            break;
        }
    }
    if (isSnapshot) {
        args.version = semver.inc(args.version, 'patch') + '-SNAPSHOT';
    }

    return Object.keys(args).reduce(function (arr, key) {
        return arr.concat('-D' + key + '=' + args[key]);
    }, []);
}

function check (cmd, err, stdout, stderr) {
    if (err) {
        if (err.code === 'ENOENT') {
            console.error(cmd + ' command not found. Do you have it in your PATH?');
        } else {
            console.error(stdout);
            console.error(stderr);
        }
        exit();
    }
}

function command (cmd, done) {
    console.log('Executing command: ' + cmd);
    exec(cmd, function (err, stdout, stderr) {
        check(cmd, err, stdout, stderr);
        if (done) { done(err, stdout, stderr); }
    });
}

function mvn (args, repoId, isSnapshot, done) {
    command('mvn -B ' + args.concat(mvnArgs(repoId, isSnapshot)).join(' '), done);
}

function exit(){
    process.exit(1);
}

function getConfig () {
    var configTmpl = extend({}, DEFAULT_CONFIG);
    if (userConfig) { configTmpl = extend(configTmpl, userConfig); }
    pkg = readPackageJSON(configTmpl.fileEncoding);
    return filterConfig(configTmpl, pkg);
}

function setUserConfig (_userConfig) {
    validateConfig(_userConfig);
    userConfig = _userConfig;
}

var maven = {
    config: setUserConfig,

    package: function (done) {
        var archive = new JSZip();
        var conf = getConfig();

        walk.walkSync(conf.buildDir, function (base, file, stat) {
            if (stat.isDirectory() || file.indexOf(conf.finalName + '.' + conf.type) === 0) {
                return;
            }
            var filePath = path.join(base, file);

            var data;
            if(isBinaryFileSync(filePath)) {
                data = fs.readFileSync(filePath);
            } else {
                data = fs.readFileSync(filePath, {'encoding': conf.fileEncoding});
            }

            archive.file(path.relative(conf.buildDir, filePath), data);
        });

        var buffer = archive.generate({type:'nodebuffer', compression:'DEFLATE'});
        var arPath = archivePath();
        console.log('archive path', arPath);
        fs.writeFileSync(arPath, buffer);

        if (done) { done(); }
    },

    install: function (done) {
        this.package();
        mvn(['install:install-file'], null, true, done);
    },

    deploy: function (repoId, isSnapshot, done) {
        var conf = getConfig();
        if (typeof isSnapshot == 'function') { done = isSnapshot; isSnapshot = false; }
        validateRepos(conf);
        if (conf.repositories.length === 0) {
            throw new Error('Maven repositories have to include at least one repository with ‘id’ and ‘url’.');
        }
        conf.repositories.forEach(validateRepo);
        this.package();
        mvn(['deploy:deploy-file'], repoId, isSnapshot, done);
    }
};

module.exports = maven;
